// Types mirrored from interfaces/contract-abi.json `$defs` (interfaces-v2). Read-only views only.

export type U128 = string;
export type U64 = string;
export type AccountId = string;

export type Move = 'C' | 'D' | 'F';
export type SeasonStatus = 'pending_key' | 'key_failed' | 'commit' | 'play' | 'settled' | 'cancelled';
export type MatchStatus = 'scheduled' | 'pending' | 'settled' | 'void' | 'refunded';

export interface SeasonParams {
  commit_deadline_ns: U64;
  play_deadline_ns: U64;
  unit_yocto: U128;
  bond_yocto: U128;
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
  pubkey: string | null;
  entry_deposit_yocto: U128;
  stake_per_agent_yocto: U128 | null;
  n_entries: number;
  total_rounds: number;
  rounds_scheduled: number;
  n_matches: number;
  n_settled: number;
  n_void: number;
  pool_yocto: U128;
  opened_at_ns: U64;
  closed_at_ns: U64 | null;
  settled_at_ns: U64 | null;
}

export interface Config {
  owner: AccountId;
  outlayer_account: AccountId;
  wasm_url: string;
  wasm_hash: string;
  secrets_owner: AccountId;
  secrets_profile: string;
  nearai_signer: string;
  current_season_id: number | null;
}

export interface Agent {
  agent_id: AccountId;
  name: string;
  owner: AccountId;
  registered_at_ns: U64;
  budget_yocto: U128;
  seasons: number[];
}

export interface ParentRef {
  season_id: number;
  agent_id: AccountId;
}

export interface Entry {
  season_id: number;
  agent_id: AccountId;
  owner: AccountId;
  family: string;
  parent: ParentRef | null;
  commitment: string;
  ciphertext_hex: string;
  committed_at_ns: U64;
}

export interface Match {
  season_id: number;
  a: AccountId;
  b: AccountId;
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
  agent_id: AccountId;
  owner: AccountId;
  family: string;
  matches_counted: number;
  total_payoff_counted: number;
  avg_payoff_milli: number;
  rank: number | null;
  prize_yocto: U128;
}

export interface LineageEntry {
  season_id: number;
  agent_id: AccountId;
  commitment: string;
  family: string;
  parent: ParentRef | null;
  rank: number | null;
  avg_payoff_milli: number;
}

/** Stored by `publish_prompt` after settlement; read with `get_published_prompts` (interfaces-v3). */
export interface PublishedPrompt {
  agent_id: AccountId;
  prompt: string;
  salt: string;
  commitment: string;
}
