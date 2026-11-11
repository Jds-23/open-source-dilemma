// Executes house-agent steps (house.ts planSteps) against testnet. Shared by
// `house-agents` (incl. --prestage / --wait-commit) and `keeper --house-plan`
// (commits fired by the keeper the moment the season pubkey lands).
//
// Speed: owners run in parallel (≤ concurrency). Each owner signs its own txs
// with its own key, so parallel owners never share a nonce; one owner's steps
// stay in order. Commit txs wait only for inclusion (INCLUDED_FINAL).
//
// Pre-staged salts (ops/.state/prestage/<contract>.json, 0600): salt +
// commitment per agent, drawn before the season exists. At commit time only the
// ECIES encryption to the season key remains. An entry is deleted once its
// commit lands, so a salt (and its commitment) is never reused across seasons.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { commitment as commitmentOf, randomSalt, sealPrompt } from '@osd/sdk';
import { Account, JsonRpcProvider, KeyPair, actions, type KeyPairString } from 'near-api-js';
import { classifyError, gasFor } from './chain.ts';
import { ownerIdFor, planSteps, promptFromStrategyFile, PROMPT_MAX_BYTES, type AgentView, type CommitPlan, type Step } from './house.ts';
import { fetchAll } from './keeper.ts';
import { loadSignerKey } from './near-chain.ts';
import { mapLimit } from './retry.ts';
import { NearRpc } from './rpc.ts';
import type { TxLog } from './txlog.ts';
import type { Entry, Season } from './types.ts';

export interface HouseContext {
  network: string;
  rpcUrl: string;
  contract: string;
  opsAccount: string;
  ownerPrefix: string;
  plan: CommitPlan;
  only?: Set<string>;
  /** Directory the plan's prompt_file paths are relative to. */
  repoRoot: string;
  /** ops/ dir (for .state). */
  opsDir: string;
  gasMarginYocto: bigint;
  concurrency: number;
  log: TxLog;
}

export interface Facts {
  season: Season | null;
  agents: Map<string, AgentView | null>;
  owners: Map<string, boolean>;
  entered: Set<string>;
  claimable: Map<string, { season_id: number; amount_yocto: bigint }[]>;
}

export function credsDir(): string {
  return process.env.NEAR_CREDENTIALS_DIR ?? join(homedir(), '.near-credentials');
}

/** Prompts of the active plan entries, validated (text never printed). */
export function loadPrompts(ctx: Pick<HouseContext, 'plan' | 'only' | 'repoRoot'>): Map<string, string> {
  const prompts = new Map<string, string>();
  for (const e of ctx.plan.entries) {
    if (ctx.only && !ctx.only.has(e.name)) continue;
    const p = promptFromStrategyFile(readFileSync(resolve(ctx.repoRoot, e.prompt_file), 'utf8'));
    const bytes = Buffer.byteLength(p, 'utf8');
    if (bytes === 0 || bytes > PROMPT_MAX_BYTES) throw new Error(`${e.prompt_file}: prompt is ${bytes} bytes (1..${PROMPT_MAX_BYTES})`);
    if (e.prompt_bytes !== undefined && e.prompt_bytes !== bytes) console.error(`warn: ${e.name}: plan says ${e.prompt_bytes} bytes, file has ${bytes}`);
    prompts.set(e.agent_id, p);
  }
  return prompts;
}

/** Read-only chain facts for planSteps. `seasonId` null = no season to commit to (pre-stage). */
export async function readFacts(ctx: HouseContext, seasonId: number | null): Promise<Facts> {
  const rpc = new NearRpc(ctx.rpcUrl);
  const view = <T>(m: string, a: Record<string, unknown>): Promise<T> => rpc.view<T>(ctx.contract, m, a);
  const season = seasonId === null ? null : await view<Season | null>('get_season', { season_id: seasonId });
  const entries = season ? await fetchAll<Entry>({ view }, 'get_entries', { season_id: season.season_id }) : [];
  const cfg = await view<{ current_season_id: number | null }>('get_config', {});
  const finished: number[] = [];
  for (let sid = 1; sid <= (cfg.current_season_id ?? 0); sid++) {
    if (sid === seasonId) continue;
    const s = await view<Season | null>('get_season', { season_id: sid });
    if (s && (s.status === 'settled' || s.status === 'cancelled')) finished.push(sid);
  }
  const f: Facts = { season, agents: new Map(), owners: new Map(), entered: new Set(entries.map((x) => x.agent_id)), claimable: new Map() };
  await mapLimit([...ctx.plan.entries.entries()], 8, async ([i, e]) => {
    if (ctx.only && !ctx.only.has(e.name)) return;
    const owner = ownerIdFor(i, ctx.opsAccount, ctx.ownerPrefix);
    f.owners.set(owner, await rpc.accountExists(owner).catch(() => false));
    const agent = await view<AgentView | null>('get_agent', { agent_id: e.agent_id }).catch(() => null);
    f.agents.set(e.agent_id, agent);
    if (!agent) return;
    const cl: { season_id: number; amount_yocto: bigint }[] = [];
    for (const sid of finished) {
      const amt = BigInt(await view<string>('get_claimable', { season_id: sid, agent_id: e.agent_id }).catch(() => '0'));
      if (amt > 0n) cl.push({ season_id: sid, amount_yocto: amt });
    }
    f.claimable.set(e.agent_id, cl);
  });
  return f;
}

export function stepsFor(ctx: HouseContext, facts: Facts, entryDepositYocto: bigint, noCommit: boolean): Step[] {
  return planSteps(
    ctx.plan,
    {
      accountExists: (id) => facts.owners.get(id) ?? false,
      agent: (id) => facts.agents.get(id) ?? null,
      entered: (id) => facts.entered.has(id),
      claimable: (id) => facts.claimable.get(id) ?? [],
    },
    { opsAccount: ctx.opsAccount, ownerPrefix: ctx.ownerPrefix, entryDepositYocto, gasMarginYocto: ctx.gasMarginYocto, only: ctx.only, noCommit },
  );
}

// ── pre-staged salts ────────────────────────────────────────────────────

export interface PrestagedSalt {
  salt: string;
  commitment: string;
  prompt_sha256: string;
  prompt_file: string;
}

export function prestageFile(opsDir: string, contract: string): string {
  return join(opsDir, '.state', 'prestage', `${contract}.json`);
}

function readJson<T>(file: string, dflt: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : dflt;
}

function writeSecretJson(file: string, v: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Draw salts + commitments for every agent that will commit (keeps an existing entry for an unchanged prompt). */
export function prestageSalts(file: string, items: { agent_id: string; prompt: string; prompt_file: string }[]): { fresh: number; kept: number } {
  const cur = readJson<Record<string, PrestagedSalt>>(file, {});
  let fresh = 0;
  let kept = 0;
  for (const it of items) {
    const h = sha256(it.prompt);
    if (cur[it.agent_id]?.prompt_sha256 === h) {
      kept += 1;
      continue;
    }
    const saltHex = randomSalt();
    cur[it.agent_id] = { salt: saltHex, commitment: commitmentOf(it.prompt, saltHex, it.agent_id), prompt_sha256: h, prompt_file: it.prompt_file };
    fresh += 1;
  }
  writeSecretJson(file, cur);
  return { fresh, kept };
}

/** Pre-staged salt for this prompt, if any (ignored when the prompt changed since). */
export function takePrestaged(file: string, agentId: string, prompt: string): string | undefined {
  const cur = readJson<Record<string, PrestagedSalt>>(file, {});
  const e = cur[agentId];
  return e && e.prompt_sha256 === sha256(prompt) ? e.salt : undefined;
}

export function dropPrestaged(file: string, agentId: string): void {
  const cur = readJson<Record<string, PrestagedSalt>>(file, {});
  if (!(agentId in cur)) return;
  delete cur[agentId];
  writeSecretJson(file, cur);
}

// ── execution ───────────────────────────────────────────────────────────

/** Write a key file (0600) BEFORE the tx that uses it, so a crash never loses a key. */
function loadOrCreateKey(network: string, accountId: string): string {
  const file = join(credsDir(), network, `${accountId}.json`);
  if (existsSync(file)) return KeyPair.fromString(loadSignerKey(network, accountId, { ...process.env, NEAR_PRIVATE_KEY: '' })).getPublicKey().toString();
  const kp = KeyPair.fromRandom('ed25519');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ account_id: accountId, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }) + '\n', { mode: 0o600, flag: 'wx' });
  return kp.getPublicKey().toString();
}

function saveSalt(file: string, agentId: string, rec: { salt: string; commitment: string; prompt_file: string }): void {
  const cur = readJson<Record<string, unknown>>(file, {});
  cur[agentId] = rec;
  writeSecretJson(file, cur);
}

export interface RunResult {
  ok: number;
  failed: string[];
  committed: string[];
}

/**
 * Run `steps`: owners in parallel (≤ ctx.concurrency), each owner's steps in order; a failed step stops that
 * agent only. `season` (status commit, with pubkey) is required when steps contain `commit`.
 */
export async function runSteps(ctx: HouseContext, steps: Step[], season: Season | null, prompts: Map<string, string>): Promise<RunResult> {
  const provider = new JsonRpcProvider({ url: ctx.rpcUrl });
  const accounts = new Map<string, Account>();
  const acct = (id: string, key?: KeyPairString): Account => {
    let a = accounts.get(id);
    if (!a) {
      a = new Account(id, provider, key ?? (loadSignerKey(ctx.network, id, { ...process.env, NEAR_PRIVATE_KEY: '' }) as KeyPairString));
      accounts.set(id, a);
    }
    return a;
  };
  const opsAcct = acct(ctx.opsAccount, loadSignerKey(ctx.network, ctx.opsAccount));
  const sid = season?.season_id ?? null;
  const saltFile = sid === null ? '' : join(ctx.opsDir, '.state', 'salts', ctx.contract, `season-${sid}.json`);
  const preFile = prestageFile(ctx.opsDir, ctx.contract);

  // Grouped by OWNER: one owner = one key = one nonce sequence, so an owner's txs go one after another.
  const byOwner = new Map<string, Step[]>();
  for (const s of steps) if (s.kind !== 'skip' && s.kind !== 'create_owner') byOwner.set(s.owner, [...(byOwner.get(s.owner) ?? []), s]);
  const res: RunResult = { ok: 0, failed: [], committed: [] };
  // create_owner is signed by the ops account: run those first, one at a time (one key, one nonce sequence).
  const creates = steps.filter((s) => s.kind === 'create_owner');
  for (const s of creates) {
    try {
      const pub = loadOrCreateKey(ctx.network, s.owner);
      const r = await opsAcct.createSubAccount({ accountOrPrefix: s.owner, publicKey: pub, nearToTransfer: BigInt(s.fund_yocto) });
      ctx.log.write({ kind: 'tx', season_id: sid, method: s.kind, args: { owner: s.owner, agent_id: s.agent_id }, tx_hash: r.transaction.hash, outcome: 'ok', signer: ctx.opsAccount });
      res.ok += 1;
    } catch (e) {
      fail(ctx, sid, s, e);
      res.failed.push(s.agent_id);
    }
  }

  await mapLimit([...byOwner.values()], ctx.concurrency, async (list) => {
    for (const s of list) {
      if (s.kind === 'create_owner' || s.kind === 'skip' || res.failed.includes(s.agent_id)) continue;
      try {
        const owner = acct(s.owner);
        let hash: string;
        if (s.kind === 'register_agent') {
          const pub = loadOrCreateKey(ctx.network, s.agent_id);
          const r = await owner.signAndSendTransaction({
            receiverId: ctx.contract,
            actions: [actions.functionCall('register_agent', { name: s.name, agent_public_key: pub }, gasFor('register_agent'), BigInt(s.deposit_yocto))],
            waitUntil: 'FINAL',
          });
          hash = r.transaction.hash;
        } else if (s.kind === 'claim') {
          const r = await owner.signAndSendTransaction({
            receiverId: ctx.contract,
            actions: [actions.functionCall('claim', { season_id: s.season_id, agent_id: s.agent_id }, gasFor('claim'), 0n)],
            waitUntil: 'FINAL',
          });
          hash = r.transaction.hash;
        } else if (s.kind === 'fund_agent') {
          const r = await owner.signAndSendTransaction({
            receiverId: ctx.contract,
            actions: [actions.functionCall('fund_agent', { agent_id: s.agent_id }, gasFor('fund_agent'), BigInt(s.deposit_yocto))],
            waitUntil: 'FINAL',
          });
          hash = r.transaction.hash;
        } else {
          if (!season?.pubkey || sid === null) throw new Error('commit needs a season in commit phase with a pubkey');
          const prompt = prompts.get(s.agent_id)!;
          const sealed = sealPrompt(season.pubkey, prompt, s.agent_id, takePrestaged(preFile, s.agent_id, prompt));
          saveSalt(saltFile, s.agent_id, { salt: sealed.salt, commitment: sealed.commitment, prompt_file: s.prompt_file });
          const r = await owner.signAndSendTransaction({
            receiverId: ctx.contract,
            actions: [
              actions.functionCall(
                'commit',
                { season_id: sid, agent_id: s.agent_id, ciphertext_hex: sealed.ciphertext_hex, commitment: sealed.commitment, family: s.family, parent: s.parent },
                gasFor('commit'),
                0n,
              ),
            ],
            waitUntil: 'INCLUDED_FINAL',
            throwOnFailure: true,
          });
          hash = r.transaction.hash;
          dropPrestaged(preFile, s.agent_id);
          res.committed.push(s.agent_id);
        }
        ctx.log.write({ kind: 'tx', season_id: sid, method: s.kind, args: { owner: s.owner, agent_id: s.agent_id, ...(s.kind === 'claim' ? { season_id: s.season_id } : {}) }, tx_hash: hash, outcome: 'ok', signer: s.owner });
        res.ok += 1;
      } catch (e) {
        fail(ctx, sid, s, e);
        res.failed.push(s.agent_id); // skip this agent's remaining steps; others continue
      }
    }
  });
  return res;
}

function fail(ctx: HouseContext, sid: number | null, s: Step, e: unknown): void {
  const err = classifyError(e);
  ctx.log.write({ kind: 'tx', season_id: sid, method: s.kind, args: { owner: s.owner, agent_id: s.agent_id }, outcome: err.kind === 'refused' ? 'refused' : 'error', error: err.message });
}

export function fmtStep(s: Step): string {
  switch (s.kind) {
    case 'create_owner':
      return `create_owner ${s.owner} fund=${s.fund_yocto}`;
    case 'register_agent':
      return `register_agent ${s.name} as ${s.owner} deposit=${s.deposit_yocto}`;
    case 'claim':
      return `claim ${s.agent_id} season ${s.season_id} (${s.amount_yocto} yocto → budget) as ${s.owner}`;
    case 'fund_agent':
      return `fund_agent ${s.agent_id} as ${s.owner} deposit=${s.deposit_yocto}`;
    case 'commit':
      return `commit ${s.agent_id} as ${s.owner} family=${s.family} parent=${JSON.stringify(s.parent)} prompt=${s.prompt_file}`;
    case 'skip':
      return `skip ${s.agent_id}: ${s.reason}`;
  }
}
