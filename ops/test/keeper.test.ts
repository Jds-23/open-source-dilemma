import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DryRunChain } from '../src/dry-run-chain.ts';
import { Keeper } from '../src/keeper.ts';
import { MockChain } from '../src/mock-chain.ts';
import { loadFixtures, mockFromFixtures, mockParams } from '../src/mock-fixtures.ts';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryTxLog, readJsonl, SeasonRoutedLog } from '../src/txlog.ts';
import { STALE_PENDING_BLOCKS, TGAS, type Entry } from '../src/types.ts';
import { FIXTURES, opts, SlowCalls } from './helpers.ts';

const txs = (log: MemoryTxLog, method?: string, outcome = 'ok') =>
  log.records().filter((r) => r.kind === 'tx' && (method === undefined || r.method === method) && r.outcome === outcome);

describe('keeper: full season on the mock contract', () => {
  test('plays every scheduled pair exactly once, refunds the void, settles', async () => {
    const { chain, seasonId } = mockFromFixtures(FIXTURES);
    const log = new MemoryTxLog();
    const res = await new Keeper(chain, log, opts()).run();

    assert.equal(res.status, 'settled');
    assert.equal(res.seasonId, seasonId);
    assert.equal(txs(log, 'close_commits').length, 1);
    assert.equal(txs(log, 'schedule_round').length, 5); // 6 agents → 5 rounds
    assert.equal(txs(log, 'play_match').length, 15);
    assert.equal(chain.playAccepted.size, 15);
    assert.ok([...chain.playAccepted.values()].every((n) => n === 1));
    // fixture void (fairbot vs injector, llm_status_503) → refund_void
    const refunds = txs(log, 'refund_void');
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].args?.a, 'fairbot.osd.baldingsucks7993.testnet');
    assert.equal(txs(log, 'settle_season').length, 1);
    assert.equal(chain.refused.length, 0);
    // every successful tx is logged with its hash
    assert.ok(txs(log).every((r) => typeof r.tx_hash === 'string' && r.tx_hash.length > 0));
    assert.ok(res.leaderboard && res.leaderboard.length === 6);
  });

  test('re-running after completion sends nothing', async () => {
    const { chain } = mockFromFixtures(FIXTURES);
    const log = new MemoryTxLog();
    await new Keeper(chain, log, opts()).run();
    const before = chain.sent.length;
    const res2 = await new Keeper(chain, log, opts()).run();
    assert.equal(chain.sent.length, before);
    assert.equal(res2.playSent, 0);
  });

  test('killed mid-season and resumed with the same journal: no double plays', async () => {
    const { chain } = mockFromFixtures(FIXTURES);
    const log = new MemoryTxLog();
    // stop after a few iterations (during play)
    await new Keeper(chain, log, opts({ maxIterations: 9 })).run();
    const playedFirst = txs(log, 'play_match').length;
    assert.ok(playedFirst > 0 && playedFirst <= 15, `first run played ${playedFirst}`);
    const res = await new Keeper(chain, log, opts()).run();
    assert.equal(res.status, 'settled');
    assert.ok([...chain.playAccepted.values()].every((n) => n === 1));
    assert.equal(txs(log, 'play_match').length, 15);
    assert.equal(chain.refused.filter((r) => r.method === 'play_match').length, 0);
  });

  test('resumed with an EMPTY journal: contract state alone prevents double plays', async () => {
    const { chain } = mockFromFixtures(FIXTURES);
    await new Keeper(chain, new MemoryTxLog(), opts({ maxIterations: 9 })).run();
    const res = await new Keeper(chain, new MemoryTxLog(), opts()).run();
    assert.equal(res.status, 'settled');
    assert.ok([...chain.playAccepted.values()].every((n) => n === 1));
  });

  test('concurrency limit is respected', async () => {
    const { chain } = mockFromFixtures(FIXTURES);
    const slow = new SlowCalls(chain);
    await new Keeper(slow, new MemoryTxLog(), opts({ concurrency: 3 })).run();
    assert.equal(slow.peak, 3);
    const slow1 = new SlowCalls(mockFromFixtures(FIXTURES).chain);
    await new Keeper(slow1, new MemoryTxLog(), opts({ concurrency: 1 })).run();
    assert.equal(slow1.peak, 1);
  });
});

describe('keeper: retry and backoff', () => {
  test('transient errors are retried with exponential backoff, then succeed', async () => {
    const { chain } = mockFromFixtures(FIXTURES);
    chain.faults = [{ method: 'play_match', times: 3, mode: 'transient', message: 'fetch failed: ECONNRESET' }];
    const log = new MemoryTxLog();
    const res = await new Keeper(chain, log, opts({ concurrency: 1, baseDelayMs: 1000, maxDelayMs: 8000 })).run();
    assert.equal(res.status, 'settled');
    const retries = txs(log, 'play_match', 'error');
    assert.equal(retries.length, 3);
    // random() = 0.5 → delay = 0.75·min(max, base·2^(n-1))
    assert.deepEqual(retries.map((r) => r.retry_in_ms), [750, 1500, 3000]);
    assert.ok([...chain.playAccepted.values()].every((n) => n === 1));
    assert.equal(chain.playAccepted.size, 15);
  });

  test('gives up after maxAttempts and reports failure (season still settles after the deadline)', async () => {
    const { chain } = mockFromFixtures(FIXTURES);
    chain.faults = [{ method: 'play_match', times: 1e9, mode: 'transient', message: '503 Service Unavailable' }];
    const log = new MemoryTxLog();
    const res = await new Keeper(chain, log, opts({ maxAttempts: 3, pollMs: 600_000 })).run();
    assert.ok(res.failed >= 15);
    assert.equal(chain.playAccepted.size, 0);
    // past the play deadline settle_season voids the unplayed matches
    assert.equal(res.status, 'settled');
    assert.ok(chain.matches.get(1)!.every((m) => m.status === 'refunded' && m.void_reason === 'deadline'));
  });

  test('ambiguous failure (tx landed, client saw a timeout): re-checks state and does NOT re-send', async () => {
    const { chain } = mockFromFixtures(FIXTURES);
    chain.faults = [{ method: 'play_match', times: 1, mode: 'ambiguous' }];
    const log = new MemoryTxLog();
    const res = await new Keeper(chain, log, opts({ concurrency: 1 })).run();
    assert.equal(res.status, 'settled');
    assert.ok([...chain.playAccepted.values()].every((n) => n === 1));
    assert.equal(chain.refused.filter((r) => r.method === 'play_match').length, 0, 'no wasted re-send');
    assert.equal(log.records().filter((r) => r.outcome === 'skipped' && r.method === 'play_match').length, 1);
  });

  test('contract refusal is not retried', async () => {
    const { chain } = mockFromFixtures(FIXTURES);
    // a second keeper that already raced us: mark one match pending behind the keeper's back
    const log = new MemoryTxLog();
    await new Keeper(chain, log, opts({ maxIterations: 4 })).run(); // up to scheduling (rounds go out in parallel)
    const m = chain.matches.get(1)!.find((x) => x.status === 'scheduled')!;
    const origView = chain.view.bind(chain);
    let flipped = false;
    chain.view = (async (method: string, args: Record<string, unknown>) => {
      const r = await origView(method, args);
      if (method === 'get_matches' && !flipped) {
        flipped = true;
        await chain.call('play_match', { season_id: 1, a: m.a, b: m.b }, { depositYocto: 10n ** 23n }); // the "other keeper"
      }
      return r;
    }) as typeof chain.view;
    const res = await new Keeper(chain, log, opts()).run();
    assert.equal(res.status, 'settled');
    const refused = txs(log, 'play_match', 'refused');
    assert.equal(refused.length, 1);
    assert.equal(refused[0].attempt, 1);
    assert.equal(chain.playAccepted.get(m.match_key), 1);
  });

  test('silent refusal (included but failed on execution) is re-sent once after the grace window', async () => {
    const { chain } = mockFromFixtures(FIXTURES);
    chain.faults = [{ method: 'play_match', times: 1, mode: 'silent_refusal' }];
    // make the first play_match fail on chain: drop deposit check by sending too little on the first call only
    const log = new MemoryTxLog();
    const origCall = chain.call.bind(chain);
    let first = true;
    chain.call = (async (method: string, args: Record<string, unknown>, o?: { depositYocto?: bigint }) => {
      if (method === 'play_match' && first) {
        first = false;
        return origCall(method, args, { ...o, depositYocto: 1n });
      }
      return origCall(method, args, o);
    }) as typeof chain.call;
    const res = await new Keeper(chain, log, opts({ concurrency: 1, graceBlocks: 10 })).run();
    assert.equal(res.status, 'settled');
    assert.equal(chain.playAccepted.size, 15);
    assert.ok([...chain.playAccepted.values()].every((n) => n === 1));
    assert.equal(txs(log, 'play_match').length, 16); // 15 + 1 re-send
    assert.ok(log.records().some((r) => r.kind === 'warn' && String(r.msg).includes('re-sending')));
  });
});

describe('keeper: void handling', () => {
  test('stale pending (callback never arrives) is refunded after STALE_PENDING_BLOCKS', async () => {
    const { chain } = mockFromFixtures(FIXTURES);
    const base = chain.resolver;
    chain.resolver = (m, a, b) => (m.a.startsWith('alwaysc') && m.b.startsWith('alwaysd') ? { kind: 'stuck' } : base(m, a, b));
    const log = new MemoryTxLog();
    const res = await new Keeper(chain, log, opts()).run();
    assert.equal(res.status, 'settled');
    const stuck = chain.matches.get(1)!.find((m) => m.a.startsWith('alwaysc') && m.b.startsWith('alwaysd'))!;
    assert.equal(stuck.status, 'refunded');
    assert.equal(stuck.void_reason, 'stale_pending');
    const refund = txs(log, 'refund_void').find((r) => r.args?.a === stuck.a)!;
    assert.ok(refund.block! - stuck.requested_at_block! > STALE_PENDING_BLOCKS);
    assert.equal(chain.playAccepted.get(stuck.match_key), 1, 'never re-played (one-shot rule)');
  });

  test('every match void: all refunded, none re-played', async () => {
    const { chain } = mockFromFixtures(FIXTURES);
    chain.resolver = () => ({ kind: 'void', reason: 'llm_timeout' });
    const log = new MemoryTxLog();
    const res = await new Keeper(chain, log, opts()).run();
    assert.equal(res.status, 'settled');
    assert.equal(txs(log, 'refund_void').length, 15);
    assert.ok([...chain.playAccepted.values()].every((n) => n === 1));
    assert.ok(chain.matches.get(1)!.every((m) => m.status === 'refunded'));
  });
});

describe('keeper: season lifecycle', () => {
  test('opens a season, waits for the key and the commit deadline', async () => {
    const fx = loadFixtures(FIXTURES);
    const chain = new MockChain();
    const params = mockParams(fx, chain.nowNs, 300);
    // entries arrive via the SDK during the commit window; emulate with a view hook
    const origView = chain.view.bind(chain);
    chain.view = (async (m: string, a: Record<string, unknown>) => {
      const s = chain.seasons.get(1);
      if (s?.status === 'commit' && (chain.entries.get(1) ?? []).length === 0) chain.entries.set(1, fx.entries.map((e) => ({ ...e, season_id: 1 })));
      return origView(m, a);
    }) as typeof chain.view;
    const log = new MemoryTxLog();
    const res = await new Keeper(chain, log, opts({ openParams: params })).run();
    assert.equal(res.status, 'settled');
    assert.equal(txs(log, 'open_season').length, 1);
    const close = chain.sent.find((s) => s.method === 'close_commits')!;
    assert.ok(close);
    assert.ok(chain.seasons.get(1)!.closed_at_ns! >= params.commit_deadline_ns);
  });

  test('the open_season record goes to the new season journal (<id>.jsonl), not keeper.jsonl', async () => {
    const fx = loadFixtures(FIXTURES);
    const chain = new MockChain();
    const dir = mkdtempSync(join(tmpdir(), 'osd-keeper-'));
    const log = new SeasonRoutedLog(dir, { echo: false });
    await new Keeper(chain, log, opts({ openParams: mockParams(fx, chain.nowNs, 300), settle: false, maxIterations: 3 })).run();
    const open = readJsonl(join(dir, '1.jsonl')).filter((r) => r.kind === 'tx' && r.method === 'open_season');
    assert.equal(open.length, 1);
    assert.equal(open[0].season_id, 1);
    assert.ok(open[0].tx_hash);
    // keeper.jsonl only keeps season-less notes now, never the open_season tx.
    const stray = existsSync(join(dir, 'keeper.jsonl')) ? readJsonl(join(dir, 'keeper.jsonl')) : [];
    assert.deepEqual(stray.filter((r) => r.kind === 'tx'), []);
  });

  test('does not open a second season while one is active', async () => {
    const { chain } = mockFromFixtures(FIXTURES);
    const log = new MemoryTxLog();
    const fx = loadFixtures(FIXTURES);
    await new Keeper(chain, log, opts({ openParams: mockParams(fx, chain.nowNs) })).run();
    assert.equal(txs(log, 'open_season').length, 0);
    assert.ok(log.records().some((r) => r.kind === 'warn' && String(r.msg).includes('resuming')));
  });

  test('key_failed stops without sending', async () => {
    const fx = loadFixtures(FIXTURES);
    const chain = new MockChain({ keyFails: true });
    const log = new MemoryTxLog();
    const res = await new Keeper(chain, log, opts({ openParams: mockParams(fx, chain.nowNs) })).run();
    assert.equal(res.status, 'key_failed');
    assert.deepEqual(chain.sent.map((s) => s.method), ['open_season']);
  });

  test('fewer than 2 entries → cancelled', async () => {
    const fx = loadFixtures(FIXTURES);
    const chain = new MockChain();
    chain.seedSeason(mockParams(fx, chain.nowNs), fx.entries.slice(0, 1));
    const res = await new Keeper(chain, new MemoryTxLog(), opts()).run();
    assert.equal(res.status, 'cancelled');
  });
});

describe('keeper: dry run', () => {
  test('one planning pass, nothing reaches the contract, outcome dry_run', async () => {
    const { chain } = mockFromFixtures(FIXTURES);
    chain.advance(10 * 60_000); // past the commit deadline
    const dry = new DryRunChain(chain);
    const log = new MemoryTxLog();
    const res = await new Keeper(dry, log, opts({ once: true, okOutcome: 'dry_run' })).run();
    assert.equal(res.status, 'commit');
    assert.deepEqual(dry.planned.map((p) => p.method), ['close_commits']);
    assert.equal(chain.sent.length, 0);
    assert.equal(txs(log, undefined, 'dry_run').length, 1);
  });

  test('dry-run records never count as sends for a later real run', async () => {
    const { chain } = mockFromFixtures(FIXTURES);
    const log = new MemoryTxLog();
    chain.advance(10 * 60_000);
    await chain.call('close_commits', { season_id: 1 });
    for (let r = 0; r < 5; r++) await chain.call('schedule_round', { season_id: 1 });
    const dry = new DryRunChain(chain);
    await new Keeper(dry, log, opts({ once: true, okOutcome: 'dry_run', concurrency: 15 })).run();
    assert.equal(dry.planned.filter((p) => p.method === 'play_match').length, 15);
    const res = await new Keeper(chain, log, opts()).run();
    assert.equal(res.status, 'settled');
    assert.equal(chain.playAccepted.size, 15);
  });
});

describe('keeper: interfaces-v4', () => {
  function recordGas(chain: MockChain): Map<string, bigint> {
    const gas = new Map<string, bigint>();
    const call = chain.call.bind(chain);
    chain.call = (async (m: string, a: Record<string, unknown>, o?: { gas?: bigint; depositYocto?: bigint }) => {
      gas.set(m, o?.gas ?? 0n);
      return call(m, a, o);
    }) as typeof chain.call;
    return gas;
  }

  test('40 agents past the play deadline: settle_season is repeated while it returns [] (20 calls), 300 Tgas each', async () => {
    const fx = loadFixtures(FIXTURES);
    const chain = new MockChain();
    const entries: Omit<Entry, 'season_id'>[] = Array.from({ length: 40 }, (_, i) => ({
      ...fx.entries[0],
      agent_id: `a${String(i).padStart(2, '0')}.osd.baldingsucks7993.testnet`,
      owner: `h${String(i).padStart(2, '0')}.baldingsucks7993.testnet`,
    }));
    const sid = chain.seedSeason(mockParams(fx, chain.nowNs, 60, 3600), entries);
    chain.advance(120_000);
    await chain.call('close_commits', { season_id: sid });
    for (let r = 0; r < 39; r++) await chain.call('schedule_round', { season_id: sid });
    chain.advance(2 * 3600_000); // past the play deadline: nothing was played
    const gas = recordGas(chain);
    const log = new MemoryTxLog();
    const res = await new Keeper(chain, log, opts()).run();
    assert.equal(res.status, 'settled');
    assert.equal(chain.matches.get(sid)!.length, 780);
    assert.equal(txs(log, 'play_match').length, 0);
    assert.equal(txs(log, 'settle_season').length, 20); // ceil(780 / 40)
    assert.equal(res.settleCalls, 20);
    assert.equal(chain.settleBatches, 19);
    assert.ok(chain.matches.get(sid)!.every((m) => m.status === 'refunded' && m.void_reason === 'deadline'));
    assert.equal(gas.get('settle_season'), 300n * TGAS);
    assert.ok(log.records().some((r) => r.kind === 'phase' && String(r.msg).includes('returned []')));
  });

  test('per-method gas defaults (WS-1 recommendations)', async () => {
    const { chain } = mockFromFixtures(FIXTURES);
    const gas = recordGas(chain);
    await new Keeper(chain, new MemoryTxLog(), opts()).run();
    assert.deepEqual(Object.fromEntries([...gas].map(([m, g]) => [m, Number(g / TGAS)])), {
      close_commits: 30,
      schedule_round: 100,
      play_match: 300,
      refund_void: 30,
      settle_season: 300,
    });
  });

  test('open_season carries the per-season referee override; prize dust carries over to the next season', async () => {
    const fx = loadFixtures(FIXTURES);
    const { chain, seasonId } = mockFromFixtures(FIXTURES);
    await new Keeper(chain, new MemoryTxLog(), opts()).run();
    const s1 = chain.seasons.get(seasonId)!;
    assert.equal(s1.status, 'settled');
    const paid = (await chain.view<{ prize_yocto: string }[]>('get_leaderboard', { season_id: seasonId })).reduce((x, r) => x + BigInt(r.prize_yocto), 0n);
    assert.equal(BigInt(s1.carry_over_yocto), BigInt(s1.pool_yocto) - paid);
    const cfg = await chain.view<{ carry_over_yocto: string }>('get_config', {});
    assert.equal(cfg.carry_over_yocto, s1.carry_over_yocto);

    const over = { wasm_url: 'https://test.fastfs.io/x/outlayer.testnet/osd-referee/v2/' + 'ab'.repeat(32) + '.wasm', wasm_hash: 'ab'.repeat(32), secrets_profile: 'osd-abababababab' };
    const log = new MemoryTxLog();
    await new Keeper(chain, log, opts({ openParams: mockParams(fx, chain.nowNs), openOverrides: over, maxIterations: 3 })).run();
    const open = txs(log, 'open_season')[0];
    assert.deepEqual({ wasm_url: open.args?.wasm_url, wasm_hash: open.args?.wasm_hash, secrets_profile: open.args?.secrets_profile }, over);
    const s2 = chain.seasons.get(seasonId + 1)!;
    assert.deepEqual(s2.wasm, { url: over.wasm_url, hash: over.wasm_hash });
    assert.equal(s2.secrets_profile, over.secrets_profile);
    assert.equal(s2.carry_in_yocto, s1.carry_over_yocto);
    assert.equal(s2.pool_yocto, s1.carry_over_yocto);
  });

  test('open overrides: wasm_url without wasm_hash is rejected before sending', async () => {
    const fx = loadFixtures(FIXTURES);
    const chain = new MockChain();
    await assert.rejects(new Keeper(chain, new MemoryTxLog(), opts({ openParams: mockParams(fx, chain.nowNs), openOverrides: { wasm_url: 'https://x/y.wasm' } })).run(), /together/);
    assert.equal(chain.sent.length, 0);
  });
});
