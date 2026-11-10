#!/usr/bin/env node
// House agents from a WS-4 commit plan: create owner accounts h01..hNN under the
// ops account, fund each minimally, register one agent per owner, seal each
// prompt to the season key and commit. DRY RUN by default (read-only views,
// prints the steps); `--execute` signs and sends. Idempotent: only missing
// steps run (existing owner / registered agent / committed entry are skipped).
//
// Secrets written locally (never committed, never printed):
//   ~/.near-credentials/<net>/h01.<ops>.json   owner full-access key
//   ~/.near-credentials/<net>/<agent>.json     agent function-call key (commit/claim)
//   ops/.state/salts/season-<n>.json           commit salts (needed for publish_prompt after settle)

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sealPrompt } from '@osd/sdk';
import { Account, JsonRpcProvider, KeyPair, actions, type KeyPairString } from 'near-api-js';
import { classifyError } from '../chain.ts';
import { ownerIdFor, planSteps, promptFromStrategyFile, PROMPT_MAX_BYTES, validatePlan, type AgentView, type CommitPlan, type Step } from '../house.ts';
import { fetchAll } from '../keeper.ts';
import { loadSignerKey } from '../near-chain.ts';
import { DEFAULT_RPC, NearRpc } from '../rpc.ts';
import { SeasonRoutedLog } from '../txlog.ts';
import { gasFor } from '../chain.ts';
import { nearToYocto, type Entry, type Season } from '../types.ts';
import { banner, DEFAULTS, die, OPS_DIR, REPO_DIR, RUNS_DIR } from './common.ts';

const USAGE = `usage: pnpm --filter @osd/ops house-agents --plan agents/plans/season-1.json [options]

  --plan <file>            WS-4 commit plan (required)
  --network <testnet>      (default testnet)
  --rpc <url>
  --contract <id>          (default ${DEFAULTS.contract}; must equal plan.contract)
  --ops-account <id>       parent of the owner accounts and funder (default ${DEFAULTS.signer})
  --owner-prefix <p>       owner account label prefix (default h → h01, h02, …)
  --entry-deposit <NEAR>   used only if the season is not readable yet (default 1.22, fixture params)
  --gas-margin <NEAR>      extra per owner for gas + storage (default 0.1: prepaid gas of register_agent 50 Tgas + commit 30 Tgas is reserved at ~0.08 NEAR)
  --only <name,...>        restrict to these agent names
  --repo-root <dir>        resolve plan prompt_file paths against this dir (default: repo root)
  --execute                sign and send (otherwise dry run)
  -h, --help`;

function credsDir(): string {
  return process.env.NEAR_CREDENTIALS_DIR ?? join(homedir(), '.near-credentials');
}

/** Write a key file (0600) BEFORE the tx that uses it, so a crash never loses a key. */
function saveKey(network: string, accountId: string, kp: KeyPair): void {
  const file = join(credsDir(), network, `${accountId}.json`);
  if (existsSync(file)) die(`refusing to overwrite existing key file ${file}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ account_id: accountId, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }) + '\n', { mode: 0o600 });
}

function loadOrCreateKey(network: string, accountId: string, execute: boolean): { pub: string; created: boolean } {
  const file = join(credsDir(), network, `${accountId}.json`);
  if (existsSync(file)) {
    const kp = KeyPair.fromString(loadSignerKey(network, accountId, { ...process.env, NEAR_PRIVATE_KEY: '' }));
    return { pub: kp.getPublicKey().toString(), created: false };
  }
  const kp = KeyPair.fromRandom('ed25519');
  if (execute) saveKey(network, accountId, kp);
  return { pub: kp.getPublicKey().toString(), created: true };
}

function saveSalt(file: string, agentId: string, rec: { salt: string; commitment: string; prompt_file: string }): void {
  mkdirSync(dirname(file), { recursive: true });
  const cur = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  cur[agentId] = rec;
  writeFileSync(file, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}

async function main(): Promise<void> {
  const { values: v } = parseArgs({
    options: {
      plan: { type: 'string' },
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
  banner(v.execute);
  const network = v.network!;
  const contract = v.contract!;
  const ops = v['ops-account']!;
  const rpcUrl = v.rpc ?? DEFAULT_RPC[network] ?? die(`no default RPC for ${network}`);
  const rpc = new NearRpc(rpcUrl);
  const plan = JSON.parse(readFileSync(resolve(v.plan), 'utf8')) as CommitPlan;
  const only = v.only ? new Set(v.only.split(',')) : undefined;
  const errs = validatePlan(plan, contract, 99);
  if (errs.length) die(`plan invalid:\n  ${errs.join('\n  ')}`);
  const active = plan.entries.filter((e) => !only || only.has(e.name));

  // Prompts (read + validated up front; text is never printed).
  const prompts = new Map<string, string>();
  for (const e of active) {
    const p = promptFromStrategyFile(readFileSync(resolve(v['repo-root'] ?? REPO_DIR, e.prompt_file), 'utf8'));
    const bytes = Buffer.byteLength(p, 'utf8');
    if (bytes === 0 || bytes > PROMPT_MAX_BYTES) die(`${e.prompt_file}: prompt is ${bytes} bytes (1..${PROMPT_MAX_BYTES})`);
    if (e.prompt_bytes !== undefined && e.prompt_bytes !== bytes) console.error(`warn: ${e.name}: plan says ${e.prompt_bytes} bytes, file has ${bytes}`);
    prompts.set(e.agent_id, p);
  }

  // Chain facts (read-only). A not-yet-deployed contract reads as "nothing exists".
  let season: Season | null = null;
  let entries: Entry[] = [];
  const agents = new Map<string, AgentView | null>();
  const owners = new Map<string, boolean>();
  let contractReadable = true;
  try {
    season = await rpc.view<Season | null>(contract, 'get_season', { season_id: plan.season_id });
    entries = season ? await fetchAll<Entry>({ view: (m, a) => rpc.view(contract, m, a) }, 'get_entries', { season_id: plan.season_id }) : [];
  } catch (e) {
    contractReadable = false;
    console.error(`note: ${contract} not readable (${classifyError(e).message.slice(0, 120)}); planning as if nothing exists`);
  }
  const entryDeposit = season ? BigInt(season.entry_deposit_yocto) : nearToYocto(v['entry-deposit']!);
  for (const [i, e] of plan.entries.entries()) {
    if (only && !only.has(e.name)) continue;
    const owner = ownerIdFor(i, ops, v['owner-prefix']);
    owners.set(owner, await rpc.accountExists(owner).catch(() => false));
    agents.set(e.agent_id, contractReadable ? await rpc.view<AgentView | null>(contract, 'get_agent', { agent_id: e.agent_id }).catch(() => null) : null);
  }
  const entered = new Set(entries.map((x) => x.agent_id));

  const steps = planSteps(
    plan,
    { accountExists: (id) => owners.get(id) ?? false, agent: (id) => agents.get(id) ?? null, entered: (id) => entered.has(id) },
    { opsAccount: ops, ownerPrefix: v['owner-prefix'], entryDepositYocto: entryDeposit, gasMarginYocto: nearToYocto(v['gas-margin']!), only },
  );
  const fundTotal = steps.reduce((a, s) => a + (s.kind === 'create_owner' ? BigInt(s.fund_yocto) : 0n), 0n);

  console.error(`plan season ${plan.season_id}: ${active.length} agents; season status ${season?.status ?? 'n/a'}; entry deposit ${entryDeposit} yocto`);
  console.error(`ops account ${ops} funds ${steps.filter((s) => s.kind === 'create_owner').length} new owner(s): ${Number(fundTotal / 10n ** 21n) / 1000} NEAR total`);
  for (const s of steps) console.error(`  ${fmt(s)}`);

  if (!v.execute) {
    console.error('\nDRY RUN: nothing sent. Re-run with --execute.');
    return;
  }
  if (!season || season.status !== 'commit' || !season.pubkey) die(`season ${plan.season_id} is not in commit phase (status ${season?.status ?? 'missing'})`);

  const provider = new JsonRpcProvider({ url: rpcUrl });
  const log = new SeasonRoutedLog(contract === DEFAULTS.contract ? RUNS_DIR : join(RUNS_DIR, contract));
  const saltFile = join(OPS_DIR, '.state', 'salts', `${contract}`, `season-${plan.season_id}.json`);
  const opsAcct = new Account(ops, provider, loadSignerKey(network, ops));
  const acct = (id: string): Account => new Account(id, provider, loadSignerKey(network, id, { ...process.env, NEAR_PRIVATE_KEY: '' }) as KeyPairString);
  const sid = plan.season_id;

  const failed = new Set<string>();
  for (const s of steps) {
    if (s.kind === 'skip' || failed.has(s.agent_id)) continue;
    try {
      let hash: string | undefined;
      if (s.kind === 'create_owner') {
        const { pub } = loadOrCreateKey(network, s.owner, true);
        const r = await opsAcct.createSubAccount({ accountOrPrefix: s.owner, publicKey: pub, nearToTransfer: BigInt(s.fund_yocto) });
        hash = r.transaction.hash;
      } else if (s.kind === 'register_agent') {
        const { pub } = loadOrCreateKey(network, s.agent_id, true);
        const r = await acct(s.owner).signAndSendTransaction({
          receiverId: contract,
          actions: [actions.functionCall('register_agent', { name: s.name, agent_public_key: pub }, gasFor('register_agent'), BigInt(s.deposit_yocto))],
          waitUntil: 'FINAL',
        });
        hash = r.transaction.hash;
      } else if (s.kind === 'fund_agent') {
        const r = await acct(s.owner).signAndSendTransaction({
          receiverId: contract,
          actions: [actions.functionCall('fund_agent', { agent_id: s.agent_id }, gasFor('fund_agent'), BigInt(s.deposit_yocto))],
          waitUntil: 'FINAL',
        });
        hash = r.transaction.hash;
      } else {
        const sealed = sealPrompt(season.pubkey, prompts.get(s.agent_id)!, s.agent_id);
        saveSalt(saltFile, s.agent_id, { salt: sealed.salt, commitment: sealed.commitment, prompt_file: s.prompt_file });
        const r = await acct(s.owner).signAndSendTransaction({
          receiverId: contract,
          actions: [
            actions.functionCall(
              'commit',
              { season_id: sid, agent_id: s.agent_id, ciphertext_hex: sealed.ciphertext_hex, commitment: sealed.commitment, family: s.family, parent: s.parent },
              gasFor('commit'),
              0n,
            ),
          ],
          waitUntil: 'FINAL',
        });
        hash = r.transaction.hash;
      }
      log.write({ kind: 'tx', season_id: sid, method: s.kind, args: { owner: s.owner, agent_id: s.agent_id }, tx_hash: hash, outcome: 'ok', signer: s.kind === 'create_owner' ? ops : s.owner });
    } catch (e) {
      const err = classifyError(e);
      log.write({ kind: 'tx', season_id: sid, method: s.kind, args: { owner: s.owner, agent_id: s.agent_id }, outcome: err.kind === 'refused' ? 'refused' : 'error', error: err.message });
      process.exitCode = 1;
      console.error(`stopping this agent's remaining steps after ${s.kind} failed; re-run to resume`);
      failed.add(s.agent_id); // skip this agent's remaining steps; others continue
    }
  }
}

function fmt(s: Step): string {
  switch (s.kind) {
    case 'create_owner':
      return `create_owner ${s.owner} fund=${s.fund_yocto}`;
    case 'register_agent':
      return `register_agent ${s.name} as ${s.owner} deposit=${s.deposit_yocto}`;
    case 'fund_agent':
      return `fund_agent ${s.agent_id} as ${s.owner} deposit=${s.deposit_yocto}`;
    case 'commit':
      return `commit ${s.agent_id} as ${s.owner} family=${s.family} parent=${JSON.stringify(s.parent)} prompt=${s.prompt_file}`;
    case 'skip':
      return `skip ${s.agent_id}: ${s.reason}`;
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
