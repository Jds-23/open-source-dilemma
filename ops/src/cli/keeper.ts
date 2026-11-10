#!/usr/bin/env node
// Season keeper CLI. Default is a DRY RUN: one read-only planning pass against
// the RPC that prints what it would send. `--execute` signs and sends.
// `--mock` drives a full season against the in-memory contract (no network).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Chain } from '../chain.ts';
import { DryRunChain } from '../dry-run-chain.ts';
import { DEFAULT_KEEPER_OPTIONS, Keeper, type KeeperOptions } from '../keeper.ts';
import { mockFromFixtures } from '../mock-fixtures.ts';
import { loadSignerKey, NearChain } from '../near-chain.ts';
import { DEFAULT_RPC } from '../rpc.ts';
import { SeasonRoutedLog } from '../txlog.ts';
import { nearToYocto, TGAS, type SeasonParams } from '../types.ts';
import { banner, DEFAULTS, die, FIXTURES_DIR, intArg, RUNS_DIR } from './common.ts';

const USAGE = `usage: pnpm --filter @osd/ops keeper [options]

  --network <testnet>        network (default testnet)
  --rpc <url>                RPC url (default fastnear for the network)
  --contract <id>            contract (default ${DEFAULTS.contract})
  --signer <id>              signing account (default ${DEFAULTS.signer}; must be the contract owner to open seasons)
  --season <n>               season to drive (default: get_config.current_season_id)
  --open <params.json>       open a new season with these SeasonParams if none is active
  --wasm-url <url>           with --open: pin this referee WASM for the new season (needs --wasm-hash)
  --wasm-hash <hex>          with --open: sha256 of that WASM (needs --wasm-url)
  --secrets-profile <name>   with --open: OutLayer secrets profile for the new season (default: get_config)
  --concurrency <n>          parallel play_match txs (default 4)
  --play-deposit <NEAR>      deposit per play_match (default 0.05; OutLayer refunds the unused part)
  --open-deposit <NEAR>      deposit for open_season (default 0.05)
  --gas-tgas <n>             gas for every call (default per method: play_match/settle_season/open_season 300,
                             schedule_round 100, close_commits/refund_void 30)
  --max-settle-calls <n>     settle_season calls per settle phase while it returns [] (default 32)
  --max-attempts <n>         attempts per tx on transient errors (default 5)
  --poll-ms <n>              poll interval (default 5000)
  --no-settle                stop before settle_season
  --runs-dir <dir>           journal dir (default ops/runs; per-season <id>.jsonl)
  --execute                  actually sign and send (otherwise dry run)
  --mock                     run a whole season against the in-memory contract built from interfaces/fixtures
  --mock-dir <dir>           fixtures dir for --mock (default interfaces/fixtures)
  --mock-at <phase>          with --plan: put the mock season in commit|play before planning
  --plan                     with --mock: dry-run planning pass on the mock (what a dry run prints on a live season)
  -h, --help`;

/** Deadlines may be written relative to now: "+90m", "+2h", "+1d", "+30s". */
function resolveDeadlines(p: SeasonParams, nowNs: bigint): SeasonParams {
  const rel = (x: string): string => {
    const m = /^\+(\d+)([smhd])$/.exec(x);
    if (!m) return x;
    const mult = { s: 1n, m: 60n, h: 3600n, d: 86400n }[m[2] as 's' | 'm' | 'h' | 'd'];
    return String(nowNs + BigInt(m[1]) * mult * 1_000_000_000n);
  };
  return { ...p, commit_deadline_ns: rel(p.commit_deadline_ns), play_deadline_ns: rel(p.play_deadline_ns) };
}

async function main(): Promise<void> {
  const { values: v } = parseArgs({
    options: {
      network: { type: 'string', default: DEFAULTS.network },
      rpc: { type: 'string' },
      contract: { type: 'string', default: DEFAULTS.contract },
      signer: { type: 'string', default: DEFAULTS.signer },
      season: { type: 'string' },
      open: { type: 'string' },
      concurrency: { type: 'string' },
      'play-deposit': { type: 'string', default: '0.05' },
      'open-deposit': { type: 'string', default: '0.05' },
      'gas-tgas': { type: 'string' },
      'wasm-url': { type: 'string' },
      'wasm-hash': { type: 'string' },
      'secrets-profile': { type: 'string' },
      'max-settle-calls': { type: 'string' },
      'max-attempts': { type: 'string' },
      'poll-ms': { type: 'string' },
      'no-settle': { type: 'boolean', default: false },
      'runs-dir': { type: 'string' },
      execute: { type: 'boolean', default: false },
      mock: { type: 'boolean', default: false },
      'mock-dir': { type: 'string' },
      'mock-at': { type: 'string' },
      plan: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });
  if (v.help) {
    console.log(USAGE);
    return;
  }

  const openParams = v.open ? resolveDeadlines(JSON.parse(readFileSync(v.open, 'utf8')) as SeasonParams, BigInt(Date.now()) * 1_000_000n) : undefined;
  if (openParams) console.error(`open params: ${JSON.stringify(openParams)}`);
  if ((v['wasm-url'] === undefined) !== (v['wasm-hash'] === undefined)) die('--wasm-url and --wasm-hash go together');
  if ((v['wasm-url'] || v['secrets-profile']) && !openParams) die('--wasm-url/--wasm-hash/--secrets-profile only apply with --open');
  if (v['wasm-hash'] !== undefined && !/^[0-9a-f]{64}$/.test(v['wasm-hash'])) die('--wasm-hash must be 64 lowercase hex');
  if (v['wasm-url'] !== undefined && !/^https:\/\/\S+$/.test(v['wasm-url'])) die('--wasm-url must be an https URL');
  const openOverrides = {
    ...(v['wasm-url'] !== undefined ? { wasm_url: v['wasm-url'], wasm_hash: v['wasm-hash'] } : {}),
    ...(v['secrets-profile'] !== undefined ? { secrets_profile: v['secrets-profile'] } : {}),
  };
  if (Object.keys(openOverrides).length) console.error(`open overrides: ${JSON.stringify(openOverrides)}`);
  const base: KeeperOptions = {
    ...DEFAULT_KEEPER_OPTIONS,
    seasonId: v.season === undefined ? undefined : intArg(v.season, 'season', 0),
    openParams,
    openOverrides: Object.keys(openOverrides).length ? openOverrides : undefined,
    openDepositYocto: nearToYocto(v['open-deposit']!),
    playDepositYocto: nearToYocto(v['play-deposit']!),
    gas: v['gas-tgas'] === undefined ? undefined : BigInt(intArg(v['gas-tgas'], 'gas-tgas', 300)) * TGAS,
    maxSettleCalls: Math.max(1, intArg(v['max-settle-calls'], 'max-settle-calls', DEFAULT_KEEPER_OPTIONS.maxSettleCalls)),
    concurrency: Math.max(1, intArg(v.concurrency, 'concurrency', DEFAULT_KEEPER_OPTIONS.concurrency)),
    maxAttempts: Math.max(1, intArg(v['max-attempts'], 'max-attempts', DEFAULT_KEEPER_OPTIONS.maxAttempts)),
    pollMs: intArg(v['poll-ms'], 'poll-ms', DEFAULT_KEEPER_OPTIONS.pollMs),
    settle: !v['no-settle'],
  };

  let chain: Chain;
  let opts = base;
  let runsDir: string;

  if (v.mock) {
    const { chain: mock, seasonId } = mockFromFixtures(v['mock-dir'] ?? FIXTURES_DIR);
    if (v['mock-at'] === 'commit' || v['mock-at'] === 'play') {
      mock.advance(10 * 60_000); // past the commit deadline
      if (v['mock-at'] === 'play') {
        await mock.call('close_commits', { season_id: seasonId });
        for (let r = 0; r < mock.seasons.get(seasonId)!.total_rounds; r++) await mock.call('schedule_round', { season_id: seasonId });
      }
    }
    chain = v.plan ? new DryRunChain(mock) : mock;
    opts = { ...base, seasonId: base.seasonId ?? seasonId, ...(v.plan ? { once: true, okOutcome: 'dry_run' as const } : {}) };
    runsDir = v['runs-dir'] ?? join(RUNS_DIR, 'mock', new Date().toISOString().replace(/[:.]/g, '-'));
    console.error(`--- MOCK: in-memory contract from ${v['mock-dir'] ?? FIXTURES_DIR}; no network ---`);
  } else {
    banner(v.execute);
    const rpcUrl = v.rpc ?? DEFAULT_RPC[v.network!] ?? die(`no default RPC for ${v.network}`);
    const key = v.execute ? loadSignerKey(v.network!, v.signer!) : undefined;
    const near = new NearChain({ network: v.network!, rpcUrl, contractId: v.contract!, signerId: v.signer!, key });
    chain = v.execute ? near : new DryRunChain(near);
    opts = v.execute ? base : { ...base, once: true, okOutcome: 'dry_run' };
    const defaultDir = v.contract === DEFAULTS.contract ? RUNS_DIR : join(RUNS_DIR, v.contract!);
    runsDir = v['runs-dir'] ?? (v.execute ? defaultDir : join(defaultDir, 'dryrun'));
  }

  const log = new SeasonRoutedLog(runsDir);
  const keeper = new Keeper(chain, log, opts);
  const res = await keeper.run();
  if (chain instanceof DryRunChain) {
    console.error(`\nDRY RUN planned ${chain.planned.length} call(s):`);
    for (const p of chain.planned) console.error(`  ${p.method} ${JSON.stringify(p.args)} deposit=${p.depositYocto} gas=${p.gas}`);
  }
  const { leaderboard, ...rest } = res;
  console.error(`\nresult: ${JSON.stringify(rest)}`);
  if (leaderboard) console.error(`leaderboard: ${leaderboard.map((r) => `${r.rank ?? '-'}:${r.agent_id.split('.')[0]}(${r.avg_payoff_milli})`).join(' ')}`);
  if (v.mock && !v.plan) {
    const m = chain as unknown as { playAccepted: Map<string, number> };
    const doubles = [...m.playAccepted.values()].filter((n) => n > 1).length;
    console.error(`mock: play_match accepted per match max=${Math.max(0, ...m.playAccepted.values())}, double plays=${doubles}`);
  }
  console.error(`journal: ${runsDir}`);
  if (res.failed > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  if (/UNKNOWN_ACCOUNT|CodeDoesNotExist|MethodNotFound/.test(msg)) console.error(`contract not deployed / not initialised yet: ${msg}\n(run ops/scripts/deploy.sh first; try --mock --plan to see a dry run)`);
  else console.error(msg);
  process.exit(1);
});
