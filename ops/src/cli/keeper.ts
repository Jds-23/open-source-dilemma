#!/usr/bin/env node
// Season keeper CLI. Default is a DRY RUN: one read-only planning pass against
// the RPC that prints what it would send. `--execute` signs and sends.
// `--mock` drives a full season against the in-memory contract (no network).

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Account, JsonRpcProvider, PublicKey, actions, type KeyPairString } from 'near-api-js';
import type { Chain } from '../chain.ts';
import { DryRunChain } from '../dry-run-chain.ts';
import { validatePlan, type CommitPlan } from '../house.ts';
import { fmtStep, loadPrompts, readFacts, runSteps, stepsFor, type HouseContext } from '../house-run.ts';
import { keeperKeyDir, listKeeperKeyFiles, loadOrCreateKeeperKeys, missingKeys, removeKeyFile } from '../keeper-keys.ts';
import { DEFAULT_KEEPER_OPTIONS, Keeper, parseDurationMs, type KeeperOptions } from '../keeper.ts';
import { mockFromFixtures } from '../mock-fixtures.ts';
import { loadSignerKey, NearChain } from '../near-chain.ts';
import { DEFAULT_RPC, NearRpc } from '../rpc.ts';
import { SeasonRoutedLog, type TxLog } from '../txlog.ts';
import { nearToYocto, TGAS, type Season, type SeasonParams } from '../types.ts';
import { banner, DEFAULTS, die, FIXTURES_DIR, intArg, OPS_DIR, REPO_DIR, RUNS_DIR } from './common.ts';

const USAGE = `usage: pnpm --filter @osd/ops keeper [options]

  --network <testnet>        network (default testnet)
  --rpc <url>                RPC url (default fastnear for the network)
  --contract <id>            contract (default ${DEFAULTS.contract})
  --signer <id>              signing account (default ${DEFAULTS.signer}; must be the contract owner to open seasons)
  --season <n>               season to drive (default: get_config.current_season_id)
  --open <params.json>       open a new season with these SeasonParams if none is active. Relative deadlines:
                             commit "+2m" = window measured from pubkey arrival (deadline = now + --pubkey-wait + 2m),
                             play "+15m" = from open time. Presets: ops/season-params.fast-{attack,10,25}.json
  --commit-window <dur>      with --open: commit window from pubkey arrival (e.g. 2m, 90s); overrides the params file
  --pubkey-wait <dur>        estimate of open_season → on_pubkey (default 45s; measured 12 s and 34 s)
  --house-plan <plan.json>   commit these house agents (house-agents plan) the moment the pubkey lands, in parallel
  --house-only <a,b,...>     with --house-plan: only these agent names
  --house-season-plan-ok     with --house-plan: allow plan.season_id != the season being committed (reuse a plan)
  --keys <K>                 sign with K extra full-access keys of --signer (added once, reused; see README) + the main key
  --drop-keys                delete the local keeper keys from --signer on chain (and their files), then exit
  --wasm-url <url>           with --open: pin this referee WASM for the new season (needs --wasm-hash)
  --wasm-hash <hex>          with --open: sha256 of that WASM (needs --wasm-url)
  --secrets-profile <name>   with --open: OutLayer secrets profile for the new season (default: get_config)
  --concurrency <n>          parallel txs: play_match, schedule_round, refund_void, house commits (default 15)
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

function durationArg(x: string | undefined, name: string): number | undefined {
  if (x === undefined) return undefined;
  const ms = parseDurationMs(x);
  if (ms === null) die(`--${name} must look like 90s, 2m, 1h`);
  return ms;
}

/** `--keys K`: load/create k01..kK and add the missing ones to the signer in ONE tx (main key signs). */
async function ensureKeeperKeys(network: string, rpcUrl: string, signer: string, mainKey: KeyPairString, k: number, log: TxLog): Promise<KeyPairString[]> {
  const dir = keeperKeyDir(network, signer);
  const { keys, created } = loadOrCreateKeeperKeys(dir, signer, k, true);
  const onChain = (await new NearRpc(rpcUrl).accessKeys(signer)).map((x) => x.public_key);
  const missing = missingKeys(keys.map((x) => x.public_key), onChain);
  console.error(`keeper keys: ${k} in ${dir} (${created.length} new files), ${missing.length} to add on chain`);
  if (missing.length) {
    const acct = new Account(signer, new JsonRpcProvider({ url: rpcUrl }), mainKey);
    const r = await acct.signAndSendTransaction({ receiverId: signer, actions: missing.map((pk) => actions.addFullAccessKey(PublicKey.fromString(pk))), waitUntil: 'FINAL' });
    log.write({ kind: 'tx', season_id: null, method: 'add_keeper_keys', args: { n: missing.length }, tx_hash: r.transaction.hash, outcome: 'ok', signer });
  }
  return keys.map((x) => x.private_key);
}

async function dropKeeperKeys(network: string, rpcUrl: string, signer: string, mainKey: KeyPairString | undefined, log: TxLog): Promise<void> {
  const files = listKeeperKeyFiles(keeperKeyDir(network, signer));
  const onChain = new Set((await new NearRpc(rpcUrl).accessKeys(signer)).map((x) => x.public_key));
  const del = files.filter((f) => onChain.has(f.key.public_key));
  console.error(`keeper keys: ${files.length} local file(s), ${del.length} on chain to delete`);
  if (!mainKey) {
    console.error('DRY RUN: nothing sent. Re-run with --execute.');
    return;
  }
  if (del.length) {
    const acct = new Account(signer, new JsonRpcProvider({ url: rpcUrl }), mainKey);
    const r = await acct.signAndSendTransaction({ receiverId: signer, actions: del.map((f) => actions.deleteKey(PublicKey.fromString(f.key.public_key))), waitUntil: 'FINAL' });
    log.write({ kind: 'tx', season_id: null, method: 'delete_keeper_keys', args: { n: del.length }, tx_hash: r.transaction.hash, outcome: 'ok', signer });
  }
  for (const f of files) removeKeyFile(f.file);
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
      'commit-window': { type: 'string' },
      'pubkey-wait': { type: 'string' },
      'house-plan': { type: 'string' },
      'house-only': { type: 'string' },
      'house-season-plan-ok': { type: 'boolean', default: false },
      keys: { type: 'string' },
      'drop-keys': { type: 'boolean', default: false },
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

  const openParams = v.open ? (JSON.parse(readFileSync(v.open, 'utf8')) as SeasonParams) : undefined;
  if (openParams) console.error(`open params (deadlines resolved against chain time at send): ${JSON.stringify(openParams)}`);
  const commitWindowMs = durationArg(v['commit-window'], 'commit-window');
  if (commitWindowMs !== undefined && !openParams) die('--commit-window only applies with --open');
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
    commitWindowMs,
    pubkeyWaitMs: durationArg(v['pubkey-wait'], 'pubkey-wait') ?? DEFAULT_KEEPER_OPTIONS.pubkeyWaitMs,
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
  let sharedLog: SeasonRoutedLog | undefined;

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
    const defaultDir = v.contract === DEFAULTS.contract ? RUNS_DIR : join(RUNS_DIR, v.contract!);
    runsDir = v['runs-dir'] ?? (v.execute ? defaultDir : join(defaultDir, 'dryrun'));
    const setupLog = new SeasonRoutedLog(runsDir);
    sharedLog = setupLog;
    if (v['drop-keys']) {
      await dropKeeperKeys(v.network!, rpcUrl, v.signer!, key, setupLog);
      return;
    }
    const k = v.keys === undefined ? 0 : intArg(v.keys, 'keys', 0);
    let extraKeys: KeyPairString[] = [];
    if (k > 0 && key) extraKeys = await ensureKeeperKeys(v.network!, rpcUrl, v.signer!, key, k, setupLog);
    else if (k > 0) console.error(`DRY RUN: would use ${k} keeper keys from ${keeperKeyDir(v.network!, v.signer!)} (adding missing ones in one AddKey tx)`);
    const near = new NearChain({ network: v.network!, rpcUrl, contractId: v.contract!, signerId: v.signer!, key, extraKeys, concurrency: base.concurrency });
    chain = v.execute ? near : new DryRunChain(near);
    opts = v.execute ? base : { ...base, once: true, okOutcome: 'dry_run' };
    if (v['house-plan']) opts = { ...opts, onCommitOpen: houseHook(v['house-plan'], v['house-only'], v['house-season-plan-ok']!, { network: v.network!, rpcUrl, contract: v.contract!, ops: v.signer!, concurrency: base.concurrency, log: setupLog }) };
  }

  const log = sharedLog ?? new SeasonRoutedLog(runsDir);
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

/** `--house-plan`: at pubkey arrival, run the house-agents commit steps (agents in parallel, each owner signs its own tx). */
function houseHook(
  planFile: string,
  only: string | undefined,
  planSeasonOk: boolean,
  o: { network: string; rpcUrl: string; contract: string; ops: string; concurrency: number; log: TxLog },
): (s: Season) => Promise<void> {
  const plan = JSON.parse(readFileSync(resolve(planFile), 'utf8')) as CommitPlan;
  const errs = validatePlan(plan, o.contract, 99);
  if (errs.length) die(`--house-plan invalid:\n  ${errs.join('\n  ')}`);
  const ctx: HouseContext = {
    network: o.network,
    rpcUrl: o.rpcUrl,
    contract: o.contract,
    opsAccount: o.ops,
    ownerPrefix: 'h',
    plan,
    only: only ? new Set(only.split(',')) : undefined,
    repoRoot: REPO_DIR,
    opsDir: OPS_DIR,
    gasMarginYocto: nearToYocto('0.1'),
    concurrency: o.concurrency,
    log: o.log,
  };
  const prompts = loadPrompts(ctx); // read + validate now, before the window opens
  return async (s: Season) => {
    if (plan.season_id !== s.season_id && !planSeasonOk) throw new Error(`plan is for season ${plan.season_id}, season is ${s.season_id} (pass --house-season-plan-ok to reuse it)`);
    const t0 = Date.now();
    const facts = await readFacts(ctx, s.season_id);
    const steps = stepsFor(ctx, facts, BigInt(s.entry_deposit_yocto), false);
    for (const st of steps) console.error(`  house: ${fmtStep(st)}`);
    const res = await runSteps(ctx, steps, s, prompts);
    o.log.write({ kind: 'info', season_id: s.season_id, msg: 'house_commits', committed: res.committed.length, failed: res.failed, wall_s: (Date.now() - t0) / 1000 });
  };
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  if (/UNKNOWN_ACCOUNT|CodeDoesNotExist|MethodNotFound/.test(msg)) console.error(`contract not deployed / not initialised yet: ${msg}\n(run ops/scripts/deploy.sh first; try --mock --plan to see a dry run)`);
  else console.error(msg);
  process.exit(1);
});
