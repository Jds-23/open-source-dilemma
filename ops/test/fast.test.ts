// Fast seasons: parallel keeper signing (KeyPool), commit window measured from
// pubkey arrival, parallel rounds, settle as soon as nothing is unfinished, and
// zero voids for the fast presets on the mock contract.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { sealPrompt } from '@osd/sdk';
import { planSteps, type CommitPlan } from '../src/house.ts';
import { dropPrestaged, prestageSalts, takePrestaged } from '../src/house-run.ts';
import { KeyPool, perKeyLimit } from '../src/key-pool.ts';
import { loadOrCreateKeeperKeys, missingKeys } from '../src/keeper-keys.ts';
import { Keeper, parseDurationMs, resolveOpenParams } from '../src/keeper.ts';
import { MockChain } from '../src/mock-chain.ts';
import { mapLimit } from '../src/retry.ts';
import { MemoryTxLog } from '../src/txlog.ts';
import { nearToYocto, type Season, type SeasonParams } from '../src/types.ts';
import { FIXTURES, OPS_FIXTURES, opts } from './helpers.ts';

const OPS = join(FIXTURES, '..', '..', 'ops');
const preset = (name: string): SeasonParams => JSON.parse(readFileSync(join(OPS, `season-params.${name}.json`), 'utf8')) as SeasonParams;
const S = 1_000_000_000n;

/**
 * A key's nonce as near-api-js handles it: the client reserves `local + 1` per tx, the chain accepts a tx only if
 * its nonce is larger than the key's last INCLUDED nonce. Parallel txs on one key can therefore land out of order
 * and be rejected; the pool's one-in-flight-per-key rule must make that impossible.
 */
class NonceModel {
  readonly local: number[];
  readonly chain: number[];
  readonly used = new Set<string>();
  rejected = 0;
  reused = 0;
  inFlight: number[];
  peakPerKey = 0;
  constructor(k: number) {
    this.local = Array.from({ length: k }, () => 100);
    this.chain = Array.from({ length: k }, () => 100);
    this.inFlight = Array.from({ length: k }, () => 0);
  }
  async send(key: number, delayMs: number): Promise<void> {
    const nonce = ++this.local[key];
    const id = `${key}:${nonce}`;
    if (this.used.has(id)) this.reused += 1;
    this.used.add(id);
    this.inFlight[key] += 1;
    this.peakPerKey = Math.max(this.peakPerKey, this.inFlight[key]);
    await new Promise((r) => setTimeout(r, delayMs));
    this.inFlight[key] -= 1;
    if (nonce <= this.chain[key]) this.rejected += 1;
    else this.chain[key] = nonce;
  }
}

describe('parallel keeper signing (KeyPool)', () => {
  test('15 keys, 15 parallel txs: no nonce reuse, no out-of-order rejection, every key used round-robin', async () => {
    const K = 15;
    const model = new NonceModel(K);
    const pool = new KeyPool(
      Array.from({ length: K }, (_, i) => i),
      perKeyLimit(15, K),
    );
    let seed = 7;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    await mapLimit(Array.from({ length: 300 }), 15, () => pool.use((key) => model.send(key, 1 + Math.floor(rnd() * 6))));
    assert.equal(model.used.size, 300);
    assert.equal(model.reused, 0);
    assert.equal(model.rejected, 0);
    assert.equal(model.peakPerKey, 1);
    assert.ok(pool.used.every((n) => n > 0), `every key used: ${pool.used.join(',')}`);
    assert.equal(
      pool.used.reduce((a, b) => a + b, 0),
      300,
    );
  });

  test('round-robin: with no contention keys are taken in order k0, k1, …', async () => {
    const pool = new KeyPool(['a', 'b', 'c'], 1);
    const order: string[] = [];
    for (let i = 0; i < 6; i++) await pool.use(async (k) => void order.push(k));
    assert.deepEqual(order, ['a', 'b', 'c', 'a', 'b', 'c']);
  });

  test('more parallel txs than keys: callers wait, per-key cap holds', async () => {
    const model = new NonceModel(3);
    const pool = new KeyPool([0, 1, 2], 1);
    await mapLimit(Array.from({ length: 30 }), 10, () => pool.use((k) => model.send(k, 2)));
    assert.equal(model.peakPerKey, 1);
    assert.equal(model.rejected + model.reused, 0);
  });

  test('perKeyLimit spreads concurrency over keys (one key keeps the old shared-key behaviour)', () => {
    assert.equal(perKeyLimit(15, 16), 1);
    assert.equal(perKeyLimit(15, 15), 1);
    assert.equal(perKeyLimit(15, 4), 4);
    assert.equal(perKeyLimit(4, 1), 4);
  });

  test('keeper key files: created 0600 once, reused, missing ones detected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'osd-keys-'));
    const a = loadOrCreateKeeperKeys(dir, 'keeper.testnet', 3, true);
    assert.equal(a.created.length, 3);
    assert.equal(statSync(join(dir, 'k01.json')).mode & 0o777, 0o600);
    const b = loadOrCreateKeeperKeys(dir, 'keeper.testnet', 4, true);
    assert.deepEqual(b.created, ['k04']);
    assert.deepEqual(
      b.keys.slice(0, 3).map((k) => k.public_key),
      a.keys.map((k) => k.public_key),
    );
    assert.deepEqual(missingKeys(b.keys.map((k) => k.public_key), [b.keys[0].public_key, 'ed25519:other']), b.keys.slice(1).map((k) => k.public_key));
    assert.throws(() => loadOrCreateKeeperKeys(dir, 'someone-else.testnet', 1, false));
  });
});

describe('commit window measured from pubkey arrival', () => {
  const p = preset('fast-10');
  const now = 1_000_000n * S;

  test('durations', () => {
    assert.equal(parseDurationMs('+2m'), 120_000);
    assert.equal(parseDurationMs('90s'), 90_000);
    assert.equal(parseDurationMs('+1h'), 3_600_000);
    assert.equal(parseDurationMs('1794341641004000000'), null);
  });

  test('relative commit = now + pubkey wait + window; relative play from open; absolute kept', () => {
    const r = resolveOpenParams(p, now, { pubkeyWaitMs: 30_000 });
    assert.equal(BigInt(r.commit_deadline_ns), now + 150n * S);
    assert.equal(BigInt(r.play_deadline_ns), now + 20n * 60n * S);
    const o = resolveOpenParams(p, now, { pubkeyWaitMs: 30_000, commitWindowMs: 60_000 });
    assert.equal(BigInt(o.commit_deadline_ns), now + 90n * S);
    const abs = resolveOpenParams({ ...p, commit_deadline_ns: String(now + 5n * S), play_deadline_ns: String(now + 9n * S) }, now, { pubkeyWaitMs: 30_000 });
    assert.equal(abs.commit_deadline_ns, String(now + 5n * S));
    assert.throws(() => resolveOpenParams({ ...p, play_deadline_ns: '+1m' }, now, { pubkeyWaitMs: 30_000 }), /after the commit deadline/);
  });
});

function entryFor(i: number): { agent_id: string; owner: string; family: string } {
  const fam = ['tit_for_tat', 'always_d', 'grim', 'fairbot', 'random'][i % 5];
  return { agent_id: `a${String(i).padStart(2, '0')}.osd.baldingsucks7993.testnet`, owner: `h${String(i + 1).padStart(2, '0')}.baldingsucks7993.testnet`, family: fam };
}

/** Full fast season on the mock: keeper opens with the preset, commits N agents at pubkey arrival, plays, settles. */
async function fastSeason(name: string, n: number, mockOpts: { txMs?: number; callbackBlocks?: number; concurrency?: number } = {}) {
  const chain = new MockChain({ keyBlocks: 15, txMs: mockOpts.txMs ?? 4_000, callbackBlocks: mockOpts.callbackBlocks ?? 189 });
  const log = new MemoryTxLog();
  let committedAt: bigint | null = null;
  let pubkeySeenAt: bigint | null = null;
  const onCommitOpen = async (s: Season): Promise<void> => {
    pubkeySeenAt = chain.nowNs;
    // one commit tx per owner, all in parallel (each owner signs its own tx)
    await mapLimit(Array.from({ length: n }, (_, i) => i), 15, async (i) => {
      const e = entryFor(i);
      chain.commitAs(e.owner, { agent_id: e.agent_id, family: e.family, parent: null, commitment: 'c', ciphertext_hex: 'ab' }, s.season_id);
    });
    committedAt = chain.nowNs;
  };
  const params = { ...preset(name) };
  const openedAt = chain.nowNs;
  const res = await new Keeper(chain, log, opts({ openParams: params, onCommitOpen, pollMs: 5_000, concurrency: mockOpts.concurrency ?? 15 })).run();
  const s = chain.seasons.get(res.seasonId!)!;
  return { chain, log, res, s, openedAt, pubkeySeenAt: pubkeySeenAt as bigint | null, committedAt: committedAt as bigint | null };
}

const timing = (log: MemoryTxLog) => Object.fromEntries(log.records().filter((r) => r.msg === 'timing').map((r) => [r.mark as string, r.since_open_s as number]));

describe('fast season on the mock contract', () => {
  test('window: commits land after pubkey, close_commits right at the deadline (≥ 2 min after pubkey)', async () => {
    const { chain, log, s, openedAt, pubkeySeenAt, committedAt } = await fastSeason('fast-10', 10);
    assert.equal(s.n_entries, 10);
    const deadline = BigInt(s.params.commit_deadline_ns);
    // deadline = open + 90 s (default pubkey estimate) + 2 min; the mock key lands after 15 blocks
    assert.equal(deadline - openedAt, 210n * S); // chain time read right before open_season was sent
    assert.ok(pubkeySeenAt !== null && committedAt !== null);
    assert.ok(deadline - pubkeySeenAt! >= 120n * S, `effective window ${(deadline - pubkeySeenAt!) / S} s`);
    assert.ok(committedAt! < deadline);
    const closed = BigInt(s.closed_at_ns!);
    assert.ok(closed >= deadline && closed - deadline <= 2n * S + 4n * S, `closed ${(closed - deadline) / S} s after the deadline`);
    const t = timing(log);
    for (const m of ['opened', 'pubkey', 'commits_sent', 'closed', 'scheduled', 'all_final', 'settled']) assert.ok(m in t, `timing mark ${m}`);
    assert.ok(log.records().some((r) => String(r.msg).startsWith('pubkey landed')));
    assert.equal(chain.refused.filter((r) => r.method === 'close_commits').length, 0);
  });

  test('rounds are scheduled in parallel (one pass), none refused', async () => {
    const { chain, log } = await fastSeason('fast-10', 10);
    const sched = log.records().filter((r) => r.kind === 'tx' && r.method === 'schedule_round' && r.outcome === 'ok');
    assert.equal(sched.length, 9);
    assert.equal(chain.refused.filter((r) => r.method === 'schedule_round').length, 0);
    assert.equal(log.records().filter((r) => r.kind === 'phase' && String(r.msg).startsWith('scheduling')).length, 1);
  });

  for (const [name, n, budgetMin] of [
    ['fast-attack', 6, 10],
    ['fast-10', 10, 20],
    ['fast-25', 25, 120],
    ['fast-25', 30, 120],
  ] as const) {
    test(`${name} with ${n} agents: zero voids, settled as soon as all matches are final (well before +${budgetMin}m)`, async () => {
      // --keys 15 → ≤ 15 referee jobs in flight. Small presets keep the pessimistic mock (4 s serial txs, 189-block
      // callbacks); the 25/30-agent runs use season-1 medians (1 s txs, 112-block callbacks), since 300–435 capped
      // matches at the worst case would not fit any sane deadline.
      const big = n >= 25;
      const { chain, log, res, s } = await fastSeason(name, n, big ? { txMs: 1_000, callbackBlocks: 112 } : {});
      assert.equal(res.status, 'settled');
      const pairs = (n * (n - 1)) / 2;
      assert.equal(s.n_matches, pairs);
      assert.equal(s.n_void, 0);
      assert.ok(chain.matches.get(s.season_id)!.every((m) => m.status === 'settled'));
      assert.ok([...chain.playAccepted.values()].every((x) => x === 1));
      // settle-asap: one settle_season call, long before the play deadline
      assert.equal(log.records().filter((r) => r.kind === 'tx' && r.method === 'settle_season' && r.outcome === 'ok').length, 1);
      const settled = BigInt(s.settled_at_ns!);
      assert.ok(settled < BigInt(s.params.play_deadline_ns));
      const t = timing(log);
      assert.ok(t.settled - t.all_final <= 10, `settle ${t.settled - t.all_final} s after the last match`);
      // ≥ 15% headroom against the play deadline (was 20% before the keeper pubkey-wait default went 45 s → 90 s)
      const used = Number(settled - BigInt(s.opened_at_ns)) / 1e9;
      assert.ok(used < budgetMin * 60 * 0.85, `${name}/${n}: ${used} s of ${budgetMin * 60} s`);
    });
  }

  test('a match that never calls back is refunded, then the season settles before the deadline (no deadline wait)', async () => {
    const chain = new MockChain({ keyBlocks: 15, txMs: 4_000, callbackBlocks: 60 });
    let first = true;
    chain.resolver = (m, ea, eb) => {
      if (first) {
        first = false;
        return { kind: 'stuck' };
      }
      return { kind: 'settled', a_move: ea.family === 'always_d' ? 'D' : 'C', b_move: eb.family === 'always_d' ? 'D' : 'C' };
    };
    const log = new MemoryTxLog();
    const onCommitOpen = async (s: Season): Promise<void> => {
      for (let i = 0; i < 4; i++) {
        const e = entryFor(i);
        chain.commitAs(e.owner, { agent_id: e.agent_id, family: e.family, parent: null, commitment: 'c', ciphertext_hex: 'ab' }, s.season_id);
      }
    };
    const res = await new Keeper(chain, log, opts({ openParams: { ...preset('fast-25') }, onCommitOpen })).run();
    assert.equal(res.status, 'settled');
    const s = chain.seasons.get(res.seasonId!)!;
    assert.equal(s.n_void, 1); // the stuck one, refunded via refund_void after 250 blocks
    assert.ok(BigInt(s.settled_at_ns!) < BigInt(s.params.play_deadline_ns) - 30n * 60n * S);
  });
});

describe('house pre-stage', () => {
  const plan = JSON.parse(readFileSync(join(OPS_FIXTURES, 'plan.json'), 'utf8')) as CommitPlan;
  const o = { opsAccount: 'baldingsucks7993.testnet', entryDepositYocto: nearToYocto('0.32'), gasMarginYocto: nearToYocto('0.1') };

  test('prestage: no commit steps; old winnings are claimed before funding only the shortfall', () => {
    const steps = planSteps(
      plan,
      {
        accountExists: () => true,
        agent: (id) => ({ agent_id: id, owner: id.startsWith('grim') ? 'h01.baldingsucks7993.testnet' : id.startsWith('always-d') ? 'h02.baldingsucks7993.testnet' : 'h03.baldingsucks7993.testnet', budget_yocto: '0' }),
        entered: () => false,
        claimable: (id) => (id.startsWith('grim') ? [{ season_id: 1, amount_yocto: nearToYocto('0.4') }] : id.startsWith('always-d') ? [{ season_id: 1, amount_yocto: nearToYocto('0.12') }] : []),
      },
      { ...o, noCommit: true },
    );
    assert.ok(steps.every((s) => s.kind !== 'commit'));
    assert.deepEqual(
      steps.map((s) => `${s.kind}:${s.owner.slice(0, 3)}`),
      ['claim:h01', 'claim:h02', 'fund_agent:h02', 'fund_agent:h03'],
    );
    const fund = steps.find((s) => s.kind === 'fund_agent' && s.owner.startsWith('h02'));
    assert.equal(fund?.kind === 'fund_agent' && fund.deposit_yocto, String(nearToYocto('0.2')));
  });

  test('budget already covers the entry: nothing claimed or funded', () => {
    const steps = planSteps(
      plan,
      { accountExists: () => true, agent: (id) => ({ agent_id: id, owner: 'h01.baldingsucks7993.testnet', budget_yocto: String(nearToYocto('1')) }), entered: () => false, claimable: () => [{ season_id: 1, amount_yocto: 5n }] },
      { ...o, only: new Set(['grim']), noCommit: true },
    );
    assert.deepEqual(steps, []);
  });

  test('salts are drawn ahead, reused at commit for the same prompt, dropped after commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'osd-pre-'));
    const file = join(dir, 'pre.json');
    const r1 = prestageSalts(file, [{ agent_id: 'grim.osd.baldingsucks7993.testnet', prompt: 'P', prompt_file: 'x.md' }]);
    assert.deepEqual(r1, { fresh: 1, kept: 0 });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const r2 = prestageSalts(file, [{ agent_id: 'grim.osd.baldingsucks7993.testnet', prompt: 'P', prompt_file: 'x.md' }]);
    assert.deepEqual(r2, { fresh: 0, kept: 1 });
    const salt = takePrestaged(file, 'grim.osd.baldingsucks7993.testnet', 'P');
    assert.match(salt!, /^[0-9a-f]{64}$/);
    assert.equal(takePrestaged(file, 'grim.osd.baldingsucks7993.testnet', 'changed prompt'), undefined);
    const pre = JSON.parse(readFileSync(file, 'utf8'))['grim.osd.baldingsucks7993.testnet'];
    const v = JSON.parse(readFileSync(join(FIXTURES, 'test-key-vector.json'), 'utf8')) as { public_key_hex: string };
    assert.equal(sealPrompt(v.public_key_hex, 'P', 'grim.osd.baldingsucks7993.testnet', salt).commitment, pre.commitment);
    dropPrestaged(file, 'grim.osd.baldingsucks7993.testnet');
    assert.equal(takePrestaged(file, 'grim.osd.baldingsucks7993.testnet', 'P'), undefined);
  });

  test('in-flight cap: never more than `concurrency` matches pending at OutLayer', async () => {
    const chain = new MockChain({ keyBlocks: 15, txMs: 1_000, callbackBlocks: 60 });
    let peak = 0;
    const call = chain.call.bind(chain);
    chain.call = (async (m: string, a: Record<string, unknown>, o?: { gas?: bigint; depositYocto?: bigint }) => {
      const r = await call(m, a, o);
      if (m === 'play_match') peak = Math.max(peak, [...chain.matches.values()].flat().filter((x) => x.status === 'pending').length);
      return r;
    }) as typeof chain.call;
    const log = new MemoryTxLog();
    const onCommitOpen = async (s: Season): Promise<void> => {
      for (let i = 0; i < 10; i++) {
        const e = entryFor(i);
        chain.commitAs(e.owner, { agent_id: e.agent_id, family: e.family, parent: null, commitment: 'c', ciphertext_hex: 'ab' }, s.season_id);
      }
    };
    const res = await new Keeper(chain, log, opts({ openParams: { ...preset('fast-25') }, onCommitOpen, concurrency: 4 })).run();
    assert.equal(res.status, 'settled');
    assert.equal(chain.seasons.get(res.seasonId!)!.n_settled, 45);
    assert.ok(peak <= 4, `peak pending ${peak}`);
  });

  test('referee-side voids halve the in-flight cap and pause plays; the rest still settles', async () => {
    const chain = new MockChain({ keyBlocks: 15, txMs: 1_000, callbackBlocks: 30 });
    let bad = 3;
    chain.resolver = (_m, ea, eb) =>
      bad-- > 0 ? { kind: 'void', reason: 'bad_output' } : { kind: 'settled', a_move: ea.family === 'always_d' ? 'D' : 'C', b_move: eb.family === 'always_d' ? 'D' : 'C' };
    const log = new MemoryTxLog();
    const onCommitOpen = async (s: Season): Promise<void> => {
      for (let i = 0; i < 8; i++) {
        const e = entryFor(i);
        chain.commitAs(e.owner, { agent_id: e.agent_id, family: e.family, parent: null, commitment: 'c', ciphertext_hex: 'ab' }, s.season_id);
      }
    };
    const res = await new Keeper(chain, log, opts({ openParams: { ...preset('fast-25') }, onCommitOpen, concurrency: 8 })).run();
    assert.equal(res.status, 'settled');
    const s = chain.seasons.get(res.seasonId!)!;
    assert.equal(s.n_void, 3);
    assert.equal(s.n_settled, 25);
    const warns = log.records().filter((r) => r.kind === 'warn' && /referee-side void/.test(String(r.msg)));
    assert.ok(warns.length >= 1);
    assert.match(String(warns[0].msg), /in-flight cap → 4, plays paused 30 s/);
  });
});
