#!/usr/bin/env node
// House agents from a WS-4 commit plan: create owner accounts h01..hNN under the
// ops account, fund each minimally, register one agent per owner, seal each
// prompt to the season key and commit. DRY RUN by default (read-only views,
// prints the steps); `--execute` signs and sends. Idempotent: only missing
// steps run (existing owner / registered agent / committed entry are skipped).
//
// Fast seasons:
//   --prestage --params <season-params.json>   before open_season: create/register, claim old winnings,
//                                              fund the shortfall, draw salts. No season key needed.
//   --wait-commit                              poll until the season is in `commit` with a pubkey, then
//                                              commit every agent in parallel (one tx per owner).
//   (or let the keeper do the commits: keeper --house-plan <plan>)
//
// Secrets written locally (never committed, never printed):
//   ~/.near-credentials/<net>/h01.<ops>.json   owner full-access key
//   ~/.near-credentials/<net>/<agent>.json     agent function-call key (commit/claim)
//   ops/.state/salts/<contract>/season-<n>.json commit salts (needed for publish_prompt after settle)
//   ops/.state/prestage/<contract>.json        pre-drawn salts (deleted per agent once its commit lands)

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { entryDepositFor, validatePlan, type CommitPlan } from '../house.ts';
import { fmtStep, loadPrompts, prestageFile, prestageSalts, readFacts, runSteps, stepsFor, type HouseContext } from '../house-run.ts';
import { DEFAULT_RPC, NearRpc } from '../rpc.ts';
import { SeasonRoutedLog } from '../txlog.ts';
import { nearToYocto, type Season, type SeasonParams } from '../types.ts';
import { banner, DEFAULTS, die, intArg, OPS_DIR, REPO_DIR, RUNS_DIR } from './common.ts';

const USAGE = `usage: pnpm --filter @osd/ops house-agents --plan agents/plans/season-1.json [options]

  --plan <file>            WS-4 commit plan (required)
  --season <n|current>     season to commit to (default: plan.season_id)
  --prestage               register/claim/fund + draw salts only (no commit); run BEFORE open_season
  --params <file>          with --prestage: SeasonParams of the coming season (entry deposit = bond + 3·unit·(max_agents−1))
  --wait-commit            wait until the season is in commit with a pubkey, then commit (with --season current: the next one)
  --concurrency <n>        agents in parallel (default 15)
  --network <testnet>      (default testnet)
  --rpc <url>
  --contract <id>          (default ${DEFAULTS.contract}; must equal plan.contract)
  --ops-account <id>       parent of the owner accounts and funder (default ${DEFAULTS.signer})
  --owner-prefix <p>       owner account label prefix (default h → h01, h02, …)
  --entry-deposit <NEAR>   used only if neither the season nor --params is readable (default 1.22, fixture params)
  --gas-margin <NEAR>      extra per owner for gas + storage (default 0.1: prepaid gas of register_agent 50 Tgas + commit 30 Tgas is reserved at ~0.08 NEAR)
  --only <name,...>        restrict to these agent names
  --repo-root <dir>        resolve plan prompt_file paths against this dir (default: repo root)
  --execute                sign and send (otherwise dry run)
  -h, --help`;

async function main(): Promise<void> {
  const { values: v } = parseArgs({
    options: {
      plan: { type: 'string' },
      season: { type: 'string' },
      prestage: { type: 'boolean', default: false },
      params: { type: 'string' },
      'wait-commit': { type: 'boolean', default: false },
      concurrency: { type: 'string' },
      network: { type: 'string', default: DEFAULTS.network },
      rpc: { type: 'string' },
      contract: { type: 'string', default: DEFAULTS.contract },
      'ops-account': { type: 'string', default: DEFAULTS.signer },
      'owner-prefix': { type: 'string', default: 'h' },
      'entry-deposit': { type: 'string', default: '1.22' },
      'gas-margin': { type: 'string', default: '0.1' },
      only: { type: 'string' },
      'repo-root': { type: 'string' },
      execute: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (v.help || !v.plan) {
    console.log(USAGE);
    if (!v.plan && !v.help) process.exitCode = 2;
    return;
  }
  if (v.prestage && v['wait-commit']) die('--prestage and --wait-commit are separate steps');
  banner(v.execute);
  const network = v.network!;
  const contract = v.contract!;
  const rpcUrl = v.rpc ?? DEFAULT_RPC[network] ?? die(`no default RPC for ${network}`);
  const rpc = new NearRpc(rpcUrl);
  const plan = JSON.parse(readFileSync(resolve(v.plan), 'utf8')) as CommitPlan;
  const errs = validatePlan(plan, contract, 99);
  if (errs.length) die(`plan invalid:\n  ${errs.join('\n  ')}`);
  const ctx: HouseContext = {
    network,
    rpcUrl,
    contract,
    opsAccount: v['ops-account']!,
    ownerPrefix: v['owner-prefix']!,
    plan,
    only: v.only ? new Set(v.only.split(',')) : undefined,
    repoRoot: v['repo-root'] ?? REPO_DIR,
    opsDir: OPS_DIR,
    gasMarginYocto: nearToYocto(v['gas-margin']!),
    concurrency: Math.max(1, intArg(v.concurrency, 'concurrency', 15)),
    log: new SeasonRoutedLog(contract === DEFAULTS.contract ? RUNS_DIR : join(RUNS_DIR, contract)),
  };
  const prompts = loadPrompts(ctx);

  const currentSeason = async (): Promise<number | null> => (await rpc.view<{ current_season_id: number | null }>(contract, 'get_config', {})).current_season_id;

  if (v.prestage) {
    const params = v.params ? (JSON.parse(readFileSync(v.params, 'utf8')) as SeasonParams) : null;
    const entryDeposit = params ? entryDepositFor(params) : nearToYocto(v['entry-deposit']!);
    const facts = await readFacts(ctx, null);
    const steps = stepsFor(ctx, facts, entryDeposit, true);
    console.error(`prestage: ${prompts.size} agents; entry deposit ${entryDeposit} yocto${params ? ` (from ${v.params})` : ' (--entry-deposit)'}`);
    for (const s of steps) console.error(`  ${fmtStep(s)}`);
    const items = plan.entries.filter((e) => prompts.has(e.agent_id)).map((e) => ({ agent_id: e.agent_id, prompt: prompts.get(e.agent_id)!, prompt_file: e.prompt_file }));
    if (!v.execute) {
      console.error(`  draw salts for ${items.length} agent(s) → ${prestageFile(OPS_DIR, contract)}\n\nDRY RUN: nothing sent. Re-run with --execute.`);
      return;
    }
    const res = await runSteps(ctx, steps, null, prompts);
    const salts = prestageSalts(prestageFile(OPS_DIR, contract), items);
    console.error(`prestage done: ${res.ok} tx ok, ${res.failed.length} agent(s) failed; salts: ${salts.fresh} new, ${salts.kept} kept`);
    if (res.failed.length) process.exitCode = 1;
    return;
  }

  // Commit path.
  let sid: number | null = v.season === undefined ? plan.season_id : v.season === 'current' ? await currentSeason() : intArg(v.season, 'season', 0);
  let season: Season | null = sid === null ? null : await rpc.view<Season | null>(contract, 'get_season', { season_id: sid }).catch(() => null);
  if (v['wait-commit'] && v.execute) {
    for (let i = 0; !(season?.status === 'commit' && season.pubkey); i++) {
      if (season && v.season !== 'current' && ['play', 'settled', 'cancelled', 'key_failed'].includes(season.status)) die(`season ${sid} is ${season.status}: commit window is over`);
      if (i % 15 === 0) console.error(`waiting for season ${sid ?? '(next)'} to reach commit with a pubkey (now ${season?.status ?? 'none'})`);
      await delay(1_000);
      if (v.season === 'current') sid = await currentSeason();
      season = sid === null ? null : await rpc.view<Season | null>(contract, 'get_season', { season_id: sid }).catch(() => null);
    }
  }
  const facts = await readFacts(ctx, sid);
  const entryDeposit = season ? BigInt(season.entry_deposit_yocto) : nearToYocto(v['entry-deposit']!);
  const steps = stepsFor(ctx, facts, entryDeposit, false);
  console.error(`season ${sid ?? 'n/a'}: ${prompts.size} agents; status ${season?.status ?? 'n/a'}; entry deposit ${entryDeposit} yocto`);
  for (const s of steps) console.error(`  ${fmtStep(s)}`);
  if (!v.execute) {
    console.error('\nDRY RUN: nothing sent. Re-run with --execute.');
    return;
  }
  if (!season || season.status !== 'commit' || !season.pubkey) die(`season ${sid} is not in commit phase (status ${season?.status ?? 'missing'}); use --wait-commit`);
  const t0 = Date.now();
  const res = await runSteps(ctx, steps, season, prompts);
  console.error(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${res.committed.length} committed, ${res.failed.length} agent(s) failed`);
  if (res.failed.length) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
