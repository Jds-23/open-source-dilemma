// Types mirrored from interfaces/contract-abi.json (interfaces-v4). Do not edit
// semantics here; change the frozen interface first.

export type SeasonStatus = 'pending_key' | 'key_failed' | 'commit' | 'play' | 'settled' | 'cancelled';
export type MatchStatus = 'scheduled' | 'pending' | 'settled' | 'void' | 'refunded';
export type Move = 'C' | 'D' | 'F';

export interface SeasonParams {
  commit_deadline_ns: string;
  play_deadline_ns: string;
  unit_yocto: string;
  bond_yocto: string;
  max_agents: number;
  max_entries_per_owner: number;
  referee_template_hash: string;
  model: string;
  prize_split_bps: number[];
}

export interface Season {
  season_id: number;
  status: SeasonStatus;
  params: SeasonParams;
  wasm: { url: string; hash: string };
  secrets_profile: string;
  pubkey: string | null;
  entry_deposit_yocto: string;
  stake_per_agent_yocto: string | null;
  n_entries: number;
  total_rounds: number;
  rounds_scheduled: number;
  n_matches: number;
  n_settled: number;
  n_void: number;
  /** Includes carry_in_yocto. */
  pool_yocto: string;
  carry_in_yocto: string;
  carry_over_yocto: string;
  opened_at_ns: string;
  closed_at_ns: string | null;
  settled_at_ns: string | null;
}

export interface Parent {
  season_id: number;
  agent_id: string;
}

export interface Entry {
  season_id: number;
  agent_id: string;
  owner: string;
  family: string;
  parent: Parent | null;
  commitment: string;
  ciphertext_hex: string;
  committed_at_ns: string;
}

export interface MatchKey {
  season_id: number;
  a: string;
  b: string;
}

export interface Match extends MatchKey {
  round: number;
  match_key: string;
  status: MatchStatus;
  a_move: Move | null;
  b_move: Move | null;
  a_payoff: number;
  b_payoff: number;
  pool_delta: number;
  sig_a_ok: boolean;
  sig_b_ok: boolean;
  a_chat_id: string | null;
  b_chat_id: string | null;
  a_signed_text: string | null;
  b_signed_text: string | null;
  a_sig: string | null;
  b_sig: string | null;
  void_reason: string | null;
  requested_at_block: number | null;
  settled_at_block: number | null;
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

export interface ContractConfig {
  owner: string;
  outlayer_account: string;
  wasm_url: string;
  wasm_hash: string;
  secrets_owner: string;
  secrets_profile: string;
  nearai_signer: string;
  current_season_id: number | null;
  carry_over_yocto: string;
}

/** Optional per-season referee pin for `open_season` (interfaces-v4); wasm_url + wasm_hash only together. */
export interface OpenOverrides {
  wasm_url?: string;
  wasm_hash?: string;
  secrets_profile?: string;
}

/** `settle_season` voids at most this many unfinished matches per call after the play deadline. */
export const SETTLE_VOID_BATCH = 40;

/** `"<season_id>:<a>:<b>"` (INTERFACE.md §1). */
export function matchKeyString(k: MatchKey): string {
  return `${k.season_id}:${k.a}:${k.b}`;
}

export const STALE_PENDING_BLOCKS = 250;
export const PAGE_LIMIT = 200;
export const ONE_NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;

/** Parse "0.05" NEAR into yocto without float rounding. */
export function nearToYocto(near: string): bigint {
  if (!/^\d+(\.\d{1,24})?$/.test(near)) throw new Error(`bad NEAR amount: ${near}`);
  const [whole, frac = ''] = near.split('.');
  return BigInt(whole) * ONE_NEAR + BigInt(frac.padEnd(24, '0'));
}
