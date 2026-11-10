import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { commitment, sealPrompt } from '@osd/sdk';
import { ChainError, classifyError } from '../src/chain.ts';
import { costSummary, familyRows, matchRows, moveRows, parseEventLines, seasonSummary, toCsv, type SeasonData } from '../src/evidence.ts';
import { CHUNK_SIZE, encodeSimple, fastfsUrl, preparePayloads, sha256Hex, verifyUrl, versionedPath } from '../src/fastfs.ts';
import { ownerIdFor, planSteps, promptFromStrategyFile, registerDeposit, validatePlan, type CommitPlan } from '../src/house.ts';
import { roundRobinRound } from '../src/mock-chain.ts';
import { backoffDelay, mapLimit, withRetry } from '../src/retry.ts';
import { NearRpc, type FetchLike, type TxStatus } from '../src/rpc.ts';
import { checkSecretRow, listUserSecrets, type UserSecretInfo } from '../src/secrets.ts';
import type { Entry, LeaderboardRow, Match, Season } from '../src/types.ts';
import { nearToYocto } from '../src/types.ts';
import { FIXTURES, OPS_FIXTURES } from './helpers.ts';

const jf = <T>(dir: string, f: string): T => JSON.parse(readFileSync(join(dir, f), 'utf8')) as T;

describe('retry', () => {
  test('backoff doubles and caps', () => {
    const o = { baseDelayMs: 100, maxDelayMs: 1000, random: () => 0 };
    assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, o)), [50, 100, 200, 400, 500, 500]);
    assert.equal(backoffDelay(3, { ...o, random: () => 0.999 }), 399);
  });

  test('classifyError', () => {
    assert.equal(classifyError(new Error('fetch failed')).kind, 'transient');
    assert.equal(classifyError(new Error('rpc send_tx: HTTP 429')).kind, 'transient');
    assert.equal(classifyError(new Error('InvalidNonce { tx_nonce: 5, ak_nonce: 9 }')).kind, 'transient');
    assert.equal(classifyError(new Error('Smart contract panicked: match not scheduled')).kind, 'refused');
    assert.equal(classifyError(new Error('NotEnoughBalance')).kind, 'refused');
    assert.equal(classifyError('weird').kind, 'transient');
  });

  test('withRetry stops when beforeRetry says the work is done', async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls++;
        throw new Error('timeout');
      },
      { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {} },
      async () => false,
    );
    assert.equal(calls, 1);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.stopped, true);
  });

  test('withRetry does not retry refusals', async () => {
    let calls = 0;
    const r = await withRetry(async () => {
      calls++;
      throw new ChainError('refused', 'no');
    }, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {} });
    assert.equal(calls, 1);
    assert.equal(r.ok, false);
  });

  test('mapLimit keeps order and limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 3, 2, 4], 2, async (x) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, x));
      inFlight--;
      return x * 10;
    });
    assert.deepEqual(out, [50, 10, 30, 20, 40]);
    assert.equal(peak, 2);
  });

  test('nearToYocto', () => {
    assert.equal(nearToYocto('0.05'), 50_000_000_000_000_000_000_000n);
    assert.equal(nearToYocto('1'), 10n ** 24n);
    assert.throws(() => nearToYocto('1e3'));
  });
});

describe('mock RPC (JSON-RPC level)', () => {
  const mockFetch = (handler: (method: string, params: Record<string, unknown>) => unknown): FetchLike => async (_url, init) => {
    const req = JSON.parse(init.body) as { method: string; params: Record<string, unknown>; id: string };
    const res = handler(req.method, req.params);
    if (res instanceof Error) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, ...(res as object) }) };
  };

  test('view encodes args and decodes the JSON result', async () => {
    const season = jf<Season>(FIXTURES, 'season.json');
    let seen: Record<string, unknown> = {};
    const rpc = new NearRpc('http://mock', mockFetch((m, p) => {
      seen = p;
      assert.equal(m, 'query');
      return { result: { result: [...Buffer.from(JSON.stringify(season))], logs: [] } };
    }));
    const s = await rpc.view<Season>('osd.baldingsucks7993.testnet', 'get_season', { season_id: 1 });
    assert.equal(s.n_matches, 15);
    assert.equal(seen.request_type, 'call_function');
    assert.deepEqual(JSON.parse(Buffer.from(seen.args_base64 as string, 'base64').toString()), { season_id: 1 });
  });

  test('HTTP errors and RPC errors are classified transient / refused as appropriate', async () => {
    const down = new NearRpc('http://mock', mockFetch(() => new Error('down')));
    await assert.rejects(down.head(), (e: unknown) => classifyError(e).kind === 'transient');
    const panic = new NearRpc('http://mock', mockFetch(() => ({ result: { error: 'wasm execution failed with error: FunctionCallError(HostError(GuestPanic))' } })));
    await assert.rejects(panic.view('c', 'get_season', {}), (e: unknown) => classifyError(e).kind === 'refused');
  });

  test('head reads height + ns timestamp', async () => {
    const rpc = new NearRpc('http://mock', mockFetch(() => ({ result: { header: { height: 277078100, timestamp: 1, timestamp_nanosec: '1794316329123456789' } } })));
    assert.deepEqual(await rpc.head(), { height: 277078100, timestampNs: 1794316329123456789n });
  });

  test('accountExists maps UNKNOWN_ACCOUNT to false', async () => {
    const rpc = new NearRpc('http://mock', mockFetch(() => ({ error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: {} } } })));
    assert.equal(await rpc.accountExists('h01.x.testnet'), false);
  });
});

describe('secret profile check', () => {
  const rows = jf<UserSecretInfo[]>(OPS_FIXTURES, 'keystore-rows.spike.json');
  const hash = '5597c64221c2bfcd6c8e0e7ded8f9caee81402c741cac6abfa172ecf21205d00';

  test('spike row passes for its own contract', () => {
    const r = checkSecretRow(rows, { profile: 'season1', wasmHash: hash, contract: 'dilemma-spike.baldingsucks7993.testnet' });
    assert.equal(r.ok, true, r.problems.join('; '));
  });

  test('wrong contract, wrong hash, open access all fail', () => {
    assert.equal(checkSecretRow(rows, { profile: 'season1', wasmHash: hash, contract: 'osd.baldingsucks7993.testnet' }).ok, false);
    const rebuilt = checkSecretRow(rows, { profile: 'season1', wasmHash: 'ff'.repeat(32), contract: 'dilemma-spike.baldingsucks7993.testnet' });
    assert.equal(rebuilt.ok, false);
    assert.match(rebuilt.problems[0], /re-store the secret/);
    const open = [{ ...rows[0], access: 'AllowAll' }];
    assert.equal(checkSecretRow(open, { profile: 'season1', wasmHash: hash, contract: 'dilemma-spike.baldingsucks7993.testnet' }).ok, false);
  });

  test('listUserSecrets pages until an empty page', async () => {
    const pages = [rows, rows, []];
    let n = 0;
    const got = await listUserSecrets({ view: async <T>() => pages[n++] as T }, 'outlayer.testnet', 'x', 1);
    assert.equal(got.length, 2);
  });
});

describe('fastfs', () => {
  test('simple payload layout (borsh: variant 0, path, Some, mime, bytes)', () => {
    const p = encodeSimple('a/b.wasm', 'application/wasm', Buffer.from([1, 2, 3]));
    const expected = Buffer.concat([
      Buffer.from([0]),
      Buffer.from([8, 0, 0, 0]), Buffer.from('a/b.wasm'),
      Buffer.from([1]),
      Buffer.from([16, 0, 0, 0]), Buffer.from('application/wasm'),
      Buffer.from([3, 0, 0, 0, 1, 2, 3]),
    ]);
    assert.deepEqual(p, expected);
  });

  test('> 1 MiB is chunked at 1 MiB offsets with one shared nonce', () => {
    const big = Buffer.alloc(CHUNK_SIZE * 2 + 10, 7);
    const ps = preparePayloads('p.wasm', 'application/wasm', big, 1_769_376_240_000 + 42_000);
    assert.equal(ps.length, 3);
    const pathLen = 4 + 'p.wasm'.length;
    const offsets = ps.map((p) => p.readUInt32LE(1 + pathLen));
    assert.deepEqual(offsets, [0, CHUNK_SIZE, 2 * CHUNK_SIZE]);
    assert.ok(ps.every((p) => p.readUInt32LE(1 + pathLen + 4) === big.length));
    assert.ok(ps.every((p) => p.readUInt32LE(p.length - 4) === 42));
    assert.equal(ps[0][0], 1);
  });

  test('versioned path and URL', () => {
    const h = sha256Hex(Buffer.from('x'));
    assert.equal(versionedPath('osd-referee', 3, h), `osd-referee/v3/${h}.wasm`);
    assert.equal(fastfsUrl('testnet', 'me.testnet', 'outlayer.testnet', 'p'), 'https://test.fastfs.io/me.testnet/outlayer.testnet/p');
    assert.throws(() => versionedPath('../x', 1, h));
  });

  test('verifyUrl: waits through 404 and partial bytes, fails fast on a taken path', async () => {
    const body = Buffer.from('wasm-bytes');
    const h = sha256Hex(body);
    const seq = [{ status: 404, body: new Uint8Array() }, { status: 200, body: body.subarray(0, 4) }, { status: 200, body }];
    let i = 0;
    const ok = await verifyUrl('u', h, { get: async () => seq[i++], expectedSize: body.length, sleep: async () => {} });
    assert.deepEqual(ok, { ok: true, sha256: h, size: body.length, attempts: 3 });
    const taken = await verifyUrl('u', h, { get: async () => ({ status: 200, body: Buffer.from('other-bytes!') }), expectedSize: body.length, sleep: async () => {} });
    assert.equal(taken.ok, false);
    assert.equal(!taken.ok && taken.reason, 'mismatch');
    assert.equal(taken.attempts, 1);
  });
});

describe('round robin', () => {
  test('6 agents: 5 rounds × 3, every pair once', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const pairs = new Set<string>();
    for (let r = 0; r < 5; r++) {
      const rp = roundRobinRound(ids, r);
      assert.equal(rp.length, 3);
      for (const [x, y] of rp) pairs.add([x, y].sort().join());
    }
    assert.equal(pairs.size, 15);
  });
  test('5 agents: 5 rounds × 2 (bye), 10 pairs', () => {
    const pairs = new Set<string>();
    for (let r = 0; r < 5; r++) for (const [x, y] of roundRobinRound(['a', 'b', 'c', 'd', 'e'], r)) pairs.add([x, y].sort().join());
    assert.equal(pairs.size, 10);
  });
});

describe('evidence', () => {
  const d: SeasonData = {
    season: jf<Season>(FIXTURES, 'season.json'),
    entries: jf<Entry[]>(FIXTURES, 'entries.json'),
    matches: jf<Match[]>(FIXTURES, 'matches.json'),
    leaderboard: jf<LeaderboardRow[]>(FIXTURES, 'leaderboard.json'),
    events: parseEventLines(readFileSync(join(FIXTURES, 'events.jsonl'), 'utf8')),
  };

  test('summary matches the fixture season', () => {
    const s = seasonSummary(d);
    assert.equal(s.agents, 6);
    assert.equal(s.owners, 5);
    assert.equal(s.matches, 15);
    assert.equal(s.settled, 14);
    assert.equal(s.void_total, 1);
    assert.deepEqual(s.void_reasons, { llm_status_503: 1 });
    assert.equal(s.moves, 28);
    const c = moveRows(d).filter((m) => m.move === 'C').length;
    assert.equal(s.coop_rate, Math.round((c / 28) * 10_000) / 10_000);
    assert.equal(s.events?.match_played, 14);
    assert.equal(s.events?.match_void, 1);
    assert.equal(s.pool_yocto, d.season.pool_yocto);
    // pool from matches = Σ pool_delta × unit
    const pool = d.matches.reduce((a, m) => a + m.pool_delta, 0);
    assert.equal(BigInt(pool) * BigInt(d.season.params.unit_yocto), BigInt(d.season.pool_yocto));
  });

  test('match rows flag same-owner pairs and families', () => {
    const rows = matchRows(d);
    const same = rows.filter((r) => r.same_owner);
    assert.equal(same.length, 1); // tft + grim share alice.testnet
    assert.ok(rows.every((r) => r.a_family !== '' && r.b_family !== ''));
  });

  test('family rows sum to all moves', () => {
    const fr = familyRows(d);
    assert.equal(fr.reduce((a, f) => a + f.moves, 0), 28);
    assert.ok(fr.every((f) => f.coop_rate >= 0 && f.coop_rate <= 1));
  });

  test('cost from tx receipts: gas + OutLayer charge', () => {
    const tx = jf<TxStatus>(OPS_FIXTURES, 'tx-play_match.json');
    const hash = tx.transaction!.hash;
    const c = costSummary({
      ...d,
      runlog: [{ ts: '2026-11-10T00:00:00Z', kind: 'tx', method: 'play_match', outcome: 'ok', tx_hash: hash, args: { season_id: 1, a: 'x', b: 'y' } }],
      txs: new Map([[hash, tx]]),
    })!;
    assert.equal(c.play_txs, 1);
    assert.equal(c.outlayer_runs, 1);
    assert.equal(c.outlayer_charged_total_yocto, '1265001300000000000000');
    assert.equal(c.outlayer_time_ms?.p50, 2650);
    assert.equal(c.tokens_burnt_total_yocto, String(242800000000000000000n + 500000000000000000000n + 400000000000000000000n + 157231419097300000000n));
  });

  test('csv escaping', () => {
    assert.equal(toCsv([{ a: 'x,y', b: 'q"z', c: null }]), 'a,b,c\n"x,y","q""z",\n');
  });
});

describe('house agents', () => {
  const plan = jf<CommitPlan>(OPS_FIXTURES, 'plan.json');
  const C = 'osd.baldingsucks7993.testnet';
  const o = { opsAccount: 'baldingsucks7993.testnet', entryDepositYocto: nearToYocto('1.22'), gasMarginYocto: nearToYocto('0.05') };

  test('prompt = body without frontmatter, trimmed', () => {
    const p = promptFromStrategyFile(readFileSync(join(OPS_FIXTURES, 'strategy-grim.md'), 'utf8'));
    assert.equal(p, 'I am a grim cooperator.\nPlay C unless provoked.');
    assert.throws(() => promptFromStrategyFile('no frontmatter'));
  });

  test('owner ids h01.. under the ops account', () => {
    assert.equal(ownerIdFor(0, 'ops.testnet'), 'h01.ops.testnet');
    assert.equal(ownerIdFor(24, 'ops.testnet'), 'h25.ops.testnet');
  });

  test('validatePlan', () => {
    assert.deepEqual(validatePlan(plan, C, 25), []);
    assert.ok(validatePlan(plan, 'other.testnet', 25).length > 0);
    assert.ok(validatePlan(plan, C, 2).some((e) => e.includes('owner accounts')));
  });

  test('fresh chain: create + register + commit per agent, one owner each', () => {
    const steps = planSteps(plan, { accountExists: () => false, agent: () => null, entered: () => false }, o);
    assert.deepEqual(steps.map((s) => s.kind), ['create_owner', 'register_agent', 'commit', 'create_owner', 'register_agent', 'commit', 'create_owner', 'register_agent', 'commit']);
    const owners = new Set(steps.map((s) => s.owner));
    assert.equal(owners.size, 3);
    const reg = steps.find((s) => s.kind === 'register_agent')!;
    assert.equal(reg.kind === 'register_agent' && reg.deposit_yocto, String(registerDeposit(o.entryDepositYocto)));
    assert.equal(String(registerDeposit(o.entryDepositYocto)), String(nearToYocto('1.42')));
    const child = steps.filter((s) => s.kind === 'commit')[2];
    assert.deepEqual(child.kind === 'commit' && child.parent, { season_id: 0, agent_id: 'grim.osd.baldingsucks7993.testnet' });
  });

  test('re-run is idempotent: existing owner / agent / entry are skipped', () => {
    const steps = planSteps(
      plan,
      {
        accountExists: (id) => id.startsWith('h01') || id.startsWith('h02'),
        agent: (id) => (id.startsWith('grim') ? { agent_id: id, owner: 'h01.baldingsucks7993.testnet', budget_yocto: '0' } : id.startsWith('always-d') ? null : null),
        entered: (id) => id.startsWith('child'),
      },
      o,
    );
    assert.deepEqual(steps.map((s) => `${s.kind}:${s.owner.slice(0, 3)}`), ['fund_agent:h01', 'commit:h01', 'register_agent:h02', 'commit:h02', 'skip:h03']);
  });

  test('agent registered by someone else is never committed', () => {
    const steps = planSteps(plan, { accountExists: () => true, agent: () => ({ agent_id: 'x', owner: 'mallory.testnet', budget_yocto: '0' }), entered: () => false }, o);
    assert.ok(steps.every((s) => s.kind === 'skip'));
  });

  test('sealing uses the INTERFACE §5 commitment (test vector)', () => {
    const v = jf<{ public_key_hex: string; sample: { agent_id: string; prompt: string; salt_hex: string; commitment: string } }>(FIXTURES, 'test-key-vector.json');
    const s = sealPrompt(v.public_key_hex, v.sample.prompt, v.sample.agent_id, v.sample.salt_hex);
    assert.equal(s.commitment, v.sample.commitment);
    assert.equal(commitment(v.sample.prompt, v.sample.salt_hex, v.sample.agent_id), v.sample.commitment);
    const manual = createHash('sha256').update(Buffer.concat([Buffer.from(v.sample.prompt), Buffer.from(v.sample.salt_hex, 'hex'), Buffer.from(v.sample.agent_id)])).digest('hex');
    assert.equal(manual, v.sample.commitment);
    assert.ok(s.ciphertext_hex.length > 0 && s.ciphertext_hex.length <= 8400);
  });
});
