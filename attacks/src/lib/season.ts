// Attack-season roster, state file and helpers shared by the season-bound attacks.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { actions, KeyPair } from 'near-api-js';
import { CONTRACT, PARENT, TGAS, hasKey, keyFile, send, view, type TxOutcome } from './near.ts';
import { ATTACKS_DIR } from './results.ts';

export const REPO_ROOT = join(ATTACKS_DIR, '..');
export const PLAN_FILE = join(ATTACKS_DIR, 'season-plan.json');
/** Public, committed: season id, agent ids, commit tx hashes. */
export const STATE_FILE = join(ATTACKS_DIR, 'state', 'attack-season.json');
/** Salts (not secret for these test prompts, but kept out of git like ops/.state). */
export const SALT_FILE = join(ATTACKS_DIR, '.state', 'salts.json');
/** Keeper journal for the attack season (kept out of ops/runs). */
export const RUNS_DIR = join(ATTACKS_DIR, 'runs');

export interface PlanAgent {
  name: string;
  /** Short owner name: `h12` → h12.<parent>, `clone7` → clone7.<parent>. */
  owner: string;
  prompt_file: string;
  family: string;
  roles: string[];
}

export interface SeasonPlan {
  params: Record<string, unknown> & { commit_deadline_ns: string; play_deadline_ns: string };
  clone_register_deposit_near: string;
  agents: PlanAgent[];
}

export interface Season {
  season_id: number;
  status: 'pending_key' | 'key_failed' | 'commit' | 'play' | 'settled' | 'cancelled';
  params: { commit_deadline_ns: string; play_deadline_ns: string; unit_yocto: string; bond_yocto: string; max_agents: number; max_entries_per_owner: number };
  pubkey: string | null;
  entry_deposit_yocto: string;
  n_entries: number;
  total_rounds: number;
  rounds_scheduled: number;
  n_matches: number;
  n_settled: number;
  n_void: number;
  pool_yocto: string;
}

export interface Match {
  season_id: number;
  a: string;
  b: string;
  round: number;
  match_key: string;
  status: 'scheduled' | 'pending' | 'settled' | 'void' | 'refunded';
  a_move: 'C' | 'D' | 'F' | null;
  b_move: 'C' | 'D' | 'F' | null;
  a_payoff: number;
  b_payoff: number;
  pool_delta: number;
  sig_a_ok: boolean;
  sig_b_ok: boolean;
  void_reason: string | null;
  requested_at_block: number | null;
  settled_at_block: number | null;
}

export interface Entry {
  season_id: number;
  agent_id: string;
  owner: string;
  family: string;
  commitment: string;
  ciphertext_hex: string;
}

export interface LeaderboardRow {
  agent_id: string;
  owner: string;
  family: string;
  matches_counted: number;
  total_payoff_counted: number;
  avg_payoff_milli: number;
  rank: number | null;
  prize_yocto: string;
}

export interface AttackState {
  season_id: number | null;
  open_tx?: string;
  setup_txs: Record<string, string>;
  commits: Record<string, { tx: string; kind: 'honest' | 'duplicate' | 'mismatch' }>;
  notes: Record<string, unknown>;
}

export const ownerId = (short: string): string => `${short}.${PARENT}`;
export const agentId = (name: string): string => `${name}.${CONTRACT}`;

export function loadPlan(): SeasonPlan {
  return JSON.parse(readFileSync(PLAN_FILE, 'utf8')) as SeasonPlan;
}

export function loadState(): AttackState {
  if (!existsSync(STATE_FILE)) return { season_id: null, setup_txs: {}, commits: {}, notes: {} };
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as AttackState;
}

export function saveState(s: AttackState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n');
}

export function saveSalt(agent: string, rec: { salt: string; commitment: string; prompt_file: string }): void {
  mkdirSync(dirname(SALT_FILE), { recursive: true });
  const cur = existsSync(SALT_FILE) ? (JSON.parse(readFileSync(SALT_FILE, 'utf8')) as Record<string, unknown>) : {};
  cur[agent] = rec;
  writeFileSync(SALT_FILE, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 });
  chmodSync(SALT_FILE, 0o600);
}

/** Strategy body with the frontmatter removed and whitespace trimmed (agents/src/strategy.ts readStrategy). */
export function readPrompt(promptFile: string): string {
  const text = readFileSync(join(REPO_ROOT, promptFile), 'utf8');
  const m = /^---\n[\s\S]*?\n---\n?([\s\S]*)$/.exec(text);
  return (m ? m[1] : text).trim();
}

/** The attack season if one is recorded, else the contract's current season. */
export async function attackSeason(): Promise<Season | null> {
  const st = loadState();
  if (st.season_id === null) return null;
  return view<Season | null>('get_season', { season_id: st.season_id });
}

export async function allMatches(seasonId: number): Promise<Match[]> {
  const out: Match[] = [];
  for (let from = 0; ; from += 100) {
    const page = await view<Match[]>('get_matches', { season_id: seasonId, from_index: from, limit: 100 });
    out.push(...page);
    if (page.length < 100) return out;
  }
}

export async function allEntries(seasonId: number): Promise<Entry[]> {
  return view<Entry[]>('get_entries', { season_id: seasonId, from_index: 0, limit: 200 });
}

export function findMatch(ms: Match[], x: string, y: string): Match | undefined {
  const [a, b] = x < y ? [x, y] : [y, x];
  return ms.find((m) => m.a === a && m.b === b);
}

/** Write a fresh key file (0600) before the tx that uses it. */
export function newKeyFile(accountId: string): string {
  const file = keyFile(accountId);
  if (existsSync(file)) throw new Error(`refusing to overwrite ${file}`);
  const kp = KeyPair.fromRandom('ed25519');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ account_id: accountId, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }) + '\n', { mode: 0o600 });
  return kp.getPublicKey().toString();
}

export function publicKeyOfFile(accountId: string): string {
  const j = JSON.parse(readFileSync(keyFile(accountId), 'utf8')) as { public_key: string };
  return j.public_key;
}

/** Commit an entry from the agent's own function-call key (as a real client would). */
export async function commitEntry(
  seasonId: number,
  agent: string,
  ciphertextHex: string,
  commitmentHex: string,
  family: string,
  signer = agent,
): Promise<TxOutcome> {
  return send(signer, CONTRACT, [
    actions.functionCall(
      'commit',
      { season_id: seasonId, agent_id: agent, ciphertext_hex: ciphertextHex, commitment: commitmentHex, family, parent: null },
      30n * TGAS,
      0n,
    ),
  ]);
}

export { hasKey };

/** Make sure the agent's budget covers `need` (claims its season-1 winnings via its own FC key). */
export async function ensureBudget(agent: string, need: bigint): Promise<void> {
  const a = await view<{ budget_yocto: string } | null>('get_agent', { agent_id: agent });
  if (!a || BigInt(a.budget_yocto) >= need) return;
  const o = await send(agent, CONTRACT, [actions.functionCall('claim', { season_id: 1, agent_id: agent }, 30n * TGAS, 0n)]);
  console.log(`claim season 1 for ${agent}: ${o.ok ? 'ok' : o.error} tx ${o.txHash}`);
}
