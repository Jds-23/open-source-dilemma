// Types mirroring interfaces/contract-abi.json `$defs` (interfaces-v2).

/** yoctoNEAR as a decimal string. */
export type U128 = string;
/** Block timestamp in ns as a decimal string. */
export type U64 = string;
export type AccountId = string;
/** 64 lowercase hex chars. */
export type Hex64 = string;
/** `sha256(utf8(prompt) || salt[32] || utf8(agent_id))`, lowercase hex. */
export type Commitment = string;

export type Move = 'C' | 'D' | 'F';
export type SeasonStatus = 'pending_key' | 'key_failed' | 'commit' | 'play' | 'settled' | 'cancelled';
export type MatchStatus = 'scheduled' | 'pending' | 'settled' | 'void' | 'refunded';

export type WasmErrorCode =
  | 'bad_input'
  | 'unknown_action'
  | 'predecessor_not_allowed'
  | 'template_mismatch'
  | 'no_seed'
  | 'bad_seed'
  | 'key_derivation'
  | 'no_api_key'
  | 'duplicate_prompt'
  | 'llm_send'
  | 'llm_timeout'
  | 'llm_json'
  | `llm_status_${number}`;
export type ContractVoidReason = 'callback_failed' | 'bad_output' | 'match_key_mismatch' | 'stale_pending' | 'deadline';
export type VoidReason = WasmErrorCode | ContractVoidReason;

export interface ParentRef {
  season_id: number;
  agent_id: AccountId;
}
export type Parent = ParentRef | null;

export interface SeasonParams {
  commit_deadline_ns: U64;
  play_deadline_ns: U64;
  unit_yocto: U128;
  bond_yocto: U128;
  max_agents: number;
  max_entries_per_owner: number;
  referee_template_hash: Hex64;
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

export interface Agent {
  agent_id: AccountId;
  name: string;
  owner: AccountId;
  registered_at_ns: U64;
  budget_yocto: U128;
  seasons: number[];
}

export interface Entry {
  season_id: number;
  agent_id: AccountId;
  owner: AccountId;
  family: string;
  parent: Parent;
  commitment: Commitment;
  ciphertext_hex: string;
  committed_at_ns: U64;
}

export interface MatchKey {
  season_id: number;
  a: AccountId;
  b: AccountId;
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
  void_reason: VoidReason | null;
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
  commitment: Commitment;
  family: string;
  parent: Parent;
  rank: number | null;
  avg_payoff_milli: number | null;
}

export interface Config {
  owner: AccountId;
  outlayer_account: AccountId;
  wasm_url: string;
  wasm_hash: string;
  secrets_owner: AccountId;
  secrets_profile: string;
  nearai_signer: Hex64;
  current_season_id: number | null;
}

/** A prompt voluntarily published after settlement (`publish_prompt` tx args; shape of `fixtures/prompts.json`). */
export interface PublishedPrompt {
  season_id: number;
  agent_id: AccountId;
  family: string;
  prompt: string;
  /** 64 hex. */
  salt: string;
  published?: boolean;
}

// ---- method args / returns (snake_case, exactly as on chain) ----

export interface PageArgs {
  from_index?: number;
  limit?: number;
}

export interface ViewArgs {
  get_config: Record<string, never>;
  get_season: { season_id: number };
  get_season_pubkey: { season_id: number };
  get_entries: { season_id: number } & PageArgs;
  get_matches: { season_id: number; status?: MatchStatus } & PageArgs;
  get_leaderboard: { season_id: number };
  get_agent: { agent_id: AccountId };
  get_lineage: { agent_id: AccountId };
  get_claimable: { season_id: number; agent_id: AccountId };
}

export interface ViewReturns {
  get_config: Config;
  get_season: Season | null;
  get_season_pubkey: string | null;
  get_entries: Entry[];
  get_matches: Match[];
  get_leaderboard: LeaderboardRow[];
  get_agent: Agent | null;
  get_lineage: LineageEntry[];
  get_claimable: U128;
}

export type ViewMethod = keyof ViewArgs;

export interface CommitArgs {
  season_id: number;
  agent_id: AccountId;
  ciphertext_hex: string;
  commitment: Commitment;
  family: string;
  parent: Parent;
}

export interface CallArgs {
  register_agent: { name: string; agent_public_key: string };
  fund_agent: { agent_id: AccountId };
  withdraw: { agent_id: AccountId; amount_yocto: U128 };
  open_season: { params: SeasonParams };
  commit: CommitArgs;
  close_commits: { season_id: number };
  schedule_round: { season_id: number };
  play_match: MatchKey;
  refund_void: MatchKey;
  settle_season: { season_id: number };
  claim: { season_id: number; agent_id: AccountId };
  publish_prompt: { season_id: number; agent_id: AccountId; prompt: string; salt: string };
}

export interface CallReturns {
  register_agent: AccountId;
  fund_agent: U128;
  withdraw: U128;
  open_season: number;
  commit: null;
  close_commits: number;
  schedule_round: MatchKey[];
  play_match: string;
  refund_void: U128;
  settle_season: LeaderboardRow[];
  claim: U128;
  publish_prompt: null;
}

export type CallMethod = keyof CallArgs;
