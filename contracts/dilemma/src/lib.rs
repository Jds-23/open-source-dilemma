//! Open Source Dilemma contract (`interfaces-v7`, see `interfaces/INTERFACE.md`).
//!
//! Seasons of one-shot prisoner's dilemma between encrypted prompt strategies. Every match
//! runs once in the pinned OutLayer referee WASM (`WasmUrl{url,hash}` + `secrets_ref`, both
//! frozen per season); the result arrives in the `#[private]` `on_match` callback. A failed,
//! timed-out or malformed run voids the match: there is no retry path.
//!
//! `seal` (interfaces-v5) is a one-way switch: it deletes the contract account's access keys and
//! freezes the per-season referee overrides and `set_secrets` (v6), so after it the code, the
//! referee and the secrets ref are immutable (the ref should name a profile the contract owns).
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    env, log, near, require, AccountId, Allowance, CurveType, Gas, GasWeight, NearToken, PanicOnDefault,
    Promise, PromiseOrValue, PromiseResult, PublicKey,
};
use serde_json::{json, Value};

pub mod logic;
use logic::*;
pub use logic::Move;

pub const AGENT_ACCOUNT_FUNDING: NearToken = NearToken::from_millinear(200);
pub const MIN_REGISTER_DEPOSIT: NearToken = NearToken::from_millinear(250);
pub const FC_KEY_ALLOWANCE: NearToken = NearToken::from_millinear(250);
pub const MIN_OUTLAYER_DEPOSIT: NearToken = NearToken::from_millinear(20);
pub const STALE_PENDING_BLOCKS: u64 = 250;
pub const MAX_AGENTS: u32 = 40;
pub const MAX_PROMPT_BYTES: usize = 4000;
pub const MAX_CIPHERTEXT_HEX: usize = 8400;
pub const STAKE_UNITS_PER_MATCH: u128 = 3;
/// Methods the agent's function-call key may call (INTERFACE.md §4).
pub const AGENT_KEY_METHODS: &str = "commit,claim";
/// Referee LLM parameters sent in every `play_match` input (wasm-io.schema.json).
pub const LLM_SEED: u64 = 42;
pub const LLM_MAX_TOKENS: u32 = 4;
const PUBKEY_MAX_SECS: u64 = 30;
const MATCH_MAX_SECS: u64 = 120;
/// Static gas reserved for `on_match` (burns ~4 Tgas on testnet, season 6). Gets no share of the
/// unused gas (weight 0): the surplus goes to OutLayer.
const CALLBACK_GAS: Gas = Gas::from_tgas(40);
/// Static gas forwarded to OutLayer `request_execution` (plus all unused gas, weight 1). Season 6:
/// `request_execution` burned ~5.6 Tgas and passed the rest (~122 Tgas) to its yield callback
/// `on_execution_response` (burned ~3.3 Tgas); it ran with ~127.5 Tgas attached. F2: with ~2.6 Tgas it fails.
pub const OUTLAYER_PLAY_GAS: Gas = Gas::from_tgas(150);
/// `play_match`'s own execution + receipt creation (burned ~4 Tgas with two 4 KB ciphertexts).
pub const PLAY_OWN_GAS: Gas = Gas::from_tgas(20);
/// F2: minimum prepaid gas for `play_match` = OutLayer 150 + `on_match` 40 + own 20 = 210 Tgas.
/// Below it a caller could starve OutLayer and void the one-shot match (`callback_failed`).
/// The keeper attaches 300 Tgas.
pub const MIN_PLAY_GAS: Gas = Gas::from_tgas(
    OUTLAYER_PLAY_GAS.as_tgas() + CALLBACK_GAS.as_tgas() + PLAY_OWN_GAS.as_tgas(),
);
const REGISTER_CALLBACK_GAS: Gas = Gas::from_tgas(15);
const DEFAULT_LIMIT: u32 = 100;
/// NEAR allows 100 logs / 16 KiB of logs per receipt; each deadline void logs one `match_void`.
pub const SETTLE_VOID_BATCH: u32 = 40;
/// The final (ranking) call may void at most this many, leaving log room for `season_settled`.
pub const SETTLE_FINAL_MAX_VOIDS: u32 = 20;
const MAX_LIMIT: u32 = 200;
/// Raw storage key of the one-way seal flag. Kept outside the `Dilemma` state struct so an
/// in-place redeploy of this code over existing state needs no migration.
pub const SEALED_KEY: &[u8] = b"__osd_sealed";
/// Literal `confirm` argument `seal` requires.
pub const SEAL_CONFIRM: &str = "SEAL-FOREVER";
pub const MAX_SEAL_KEYS: usize = 32;
const SEAL_CALLBACK_GAS: Gas = Gas::from_tgas(10);

// ---------------------------------------------------------------- types

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SeasonStatus {
    PendingKey,
    KeyFailed,
    Commit,
    Play,
    Settled,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchStatus {
    Scheduled,
    Pending,
    Settled,
    Void,
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SeasonParams {
    pub commit_deadline_ns: U64,
    pub play_deadline_ns: U64,
    pub unit_yocto: U128,
    pub bond_yocto: U128,
    pub max_agents: u32,
    pub max_entries_per_owner: u32,
    pub referee_template_hash: String,
    pub model: String,
    pub prize_split_bps: Vec<u16>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct WasmSource {
    pub url: String,
    pub hash: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Parent {
    pub season_id: u32,
    pub agent_id: AccountId,
}

/// Season record. `wasm` and `secrets_*` are snapshotted at `open_season` and never change.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct SeasonState {
    pub season_id: u32,
    pub status: SeasonStatus,
    pub params: SeasonParams,
    pub wasm: WasmSource,
    pub secrets_owner: AccountId,
    pub secrets_profile: String,
    pub pubkey: Option<String>,
    pub entry_deposit_yocto: u128,
    pub stake_per_agent_yocto: Option<u128>,
    pub n_entries: u32,
    pub total_rounds: u32,
    pub rounds_scheduled: u32,
    pub n_matches: u32,
    pub n_settled: u32,
    pub n_void: u32,
    pub pool_yocto: u128,
    pub opened_at_ns: u64,
    pub closed_at_ns: Option<u64>,
    pub settled_at_ns: Option<u64>,
    /// Next match index `settle_season` scans when voiding unfinished matches in batches.
    pub settle_cursor: u32,
    /// Carry-over from earlier seasons added to this pool at `open_season`.
    pub carry_in_yocto: u128,
    /// Unpaid pool (rounding dust + unfilled prize slots) rolled to the next season.
    pub carry_over_yocto: u128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Season {
    pub season_id: u32,
    pub status: SeasonStatus,
    pub params: SeasonParams,
    pub wasm: WasmSource,
    pub secrets_profile: String,
    pub pubkey: Option<String>,
    pub entry_deposit_yocto: U128,
    pub stake_per_agent_yocto: Option<U128>,
    pub n_entries: u32,
    pub total_rounds: u32,
    pub rounds_scheduled: u32,
    pub n_matches: u32,
    pub n_settled: u32,
    pub n_void: u32,
    pub pool_yocto: U128,
    pub carry_in_yocto: U128,
    pub carry_over_yocto: U128,
    pub opened_at_ns: U64,
    pub closed_at_ns: Option<U64>,
    pub settled_at_ns: Option<U64>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct AgentState {
    pub name: String,
    pub owner: AccountId,
    pub registered_at_ns: u64,
    pub budget_yocto: u128,
    pub seasons: Vec<u32>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Agent {
    pub agent_id: AccountId,
    pub name: String,
    pub owner: AccountId,
    pub registered_at_ns: U64,
    pub budget_yocto: U128,
    pub seasons: Vec<u32>,
}

/// Committed entry (large: holds the ciphertext as bytes).
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct EntryState {
    pub index: u32,
    pub owner: AccountId,
    pub family: String,
    pub parent: Option<Parent>,
    pub commitment: String,
    pub ciphertext: Vec<u8>,
    pub committed_at_ns: u64,
}

/// Per-entry running totals (small, updated by `on_match` / `settle_season`).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct EntryStats {
    pub matches_counted: u32,
    pub total_payoff_counted: u64,
    pub forfeited: bool,
    pub rank: Option<u32>,
    pub avg_payoff_milli: Option<u64>,
    pub prize_yocto: u128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Entry {
    pub season_id: u32,
    pub agent_id: AccountId,
    pub owner: AccountId,
    pub family: String,
    pub parent: Option<Parent>,
    pub commitment: String,
    pub ciphertext_hex: String,
    pub committed_at_ns: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct MatchKey {
    pub season_id: u32,
    pub a: AccountId,
    pub b: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Match {
    pub season_id: u32,
    pub a: AccountId,
    pub b: AccountId,
    pub round: u32,
    pub match_key: String,
    pub status: MatchStatus,
    pub a_move: Option<Move>,
    pub b_move: Option<Move>,
    pub a_payoff: u8,
    pub b_payoff: u8,
    pub pool_delta: u8,
    pub sig_a_ok: bool,
    pub sig_b_ok: bool,
    pub a_chat_id: Option<String>,
    pub b_chat_id: Option<String>,
    pub a_signed_text: Option<String>,
    pub b_signed_text: Option<String>,
    pub a_sig: Option<String>,
    pub b_sig: Option<String>,
    pub void_reason: Option<String>,
    pub requested_at_block: Option<u64>,
    pub settled_at_block: Option<u64>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct LeaderboardRow {
    pub agent_id: AccountId,
    pub owner: AccountId,
    pub family: String,
    pub matches_counted: u32,
    pub total_payoff_counted: u64,
    pub avg_payoff_milli: u64,
    pub rank: Option<u32>,
    pub prize_yocto: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct LineageEntry {
    pub season_id: u32,
    pub agent_id: AccountId,
    pub commitment: String,
    pub family: String,
    pub parent: Option<Parent>,
    pub rank: Option<u32>,
    pub avg_payoff_milli: Option<u64>,
}

/// A prompt revealed with `publish_prompt` (hash-checked against the entry's commitment).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PublishedPrompt {
    pub agent_id: AccountId,
    pub prompt: String,
    pub salt: String,
    pub commitment: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Config {
    pub owner: AccountId,
    pub outlayer_account: AccountId,
    pub wasm_url: String,
    pub wasm_hash: String,
    pub secrets_owner: AccountId,
    pub secrets_profile: String,
    pub nearai_signer: String,
    pub current_season_id: Option<u32>,
    /// Unpaid prize money waiting to be added to the next season's pool.
    pub carry_over_yocto: U128,
}

/// Parsed referee result (wasm-io.schema.json `play_match_output`).
#[derive(Clone, Debug, PartialEq)]
pub struct PlayOutput {
    pub a_move: Move,
    pub b_move: Move,
    pub a_chat_id: String,
    pub b_chat_id: String,
    pub a_signed_text: String,
    pub b_signed_text: String,
    pub a_sig: String,
    pub b_sig: String,
}

/// Classify the OutLayer promise result for match `match_key`: `Ok(output)` or `Err(void_reason)`.
pub fn parse_match_result(result: Option<&[u8]>, match_key: &str) -> Result<PlayOutput, String> {
    let bytes = result.ok_or_else(|| "callback_failed".to_string())?;
    let mut v: Value = serde_json::from_slice(bytes).map_err(|_| "bad_output".to_string())?;
    // Tolerate an output delivered as a JSON string holding the JSON object.
    if let Value::String(s) = &v {
        v = serde_json::from_str(s).map_err(|_| "bad_output".to_string())?;
    }
    let o = v.as_object().ok_or_else(|| "bad_output".to_string())?;
    if let Some(mk) = o.get("match_key") {
        if mk.as_str() != Some(match_key) {
            return Err("match_key_mismatch".into());
        }
    }
    if let Some(e) = o.get("error") {
        return Err(match e.as_str() {
            Some(code) if valid_error_code(code) => code.to_string(),
            _ => "bad_output".into(),
        });
    }
    if o.get("match_key").is_none() {
        return Err("match_key_mismatch".into());
    }
    // Proof fields are flag-only; the referee may drop them to stay <= 900 B (INTERFACE.md §9.2 vi),
    // so a missing field reads as "". A present field must be a string within the schema length.
    let field = |k: &str, max: usize| -> Result<String, String> {
        match o.get(k) {
            None | Some(Value::Null) => Ok(String::new()),
            Some(Value::String(s)) if s.len() <= max => Ok(s.clone()),
            _ => Err("bad_output".into()),
        }
    };
    let mv = |k: &str| -> Result<Move, String> {
        o.get(k).and_then(|x| x.as_str()).and_then(Move::parse).ok_or_else(|| "bad_output".to_string())
    };
    Ok(PlayOutput {
        a_move: mv("a_move")?,
        b_move: mv("b_move")?,
        a_chat_id: field("a_chat_id", 64)?,
        b_chat_id: field("b_chat_id", 64)?,
        a_signed_text: field("a_signed_text", 200)?,
        b_signed_text: field("b_signed_text", 200)?,
        a_sig: field("a_sig", 128)?,
        b_sig: field("b_sig", 128)?,
    })
}

/// `ed25519_verify(sig, signed_text, signer)`; any malformed input → `false` (flag only).
pub fn check_sig(signer_hex: &str, text: &str, sig_hex: &str) -> bool {
    if text.is_empty() || sig_hex.len() != 128 {
        return false;
    }
    let (Ok(sig), Ok(pk)) = (hex::decode(sig_hex), hex::decode(signer_hex)) else { return false };
    let (Ok(sig), Ok(pk)) = (<[u8; 64]>::try_from(sig), <[u8; 32]>::try_from(pk)) else { return false };
    env::ed25519_verify(&sig, text.as_bytes(), &pk)
}

fn emit(event: &str, data: Value) {
    log!(
        "EVENT_JSON:{{\"standard\":\"osd\",\"version\":\"1.0.0\",\"event\":\"{}\",\"data\":[{}]}}",
        event,
        data
    );
}

fn match_key_str(season_id: u32, a: &AccountId, b: &AccountId) -> String {
    format!("{season_id}:{a}:{b}")
}

fn ordered(a: AccountId, b: AccountId) -> (AccountId, AccountId) {
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

/// Defense in depth for `#[private]` callbacks: `#[private]` only checks predecessor == contract,
/// which a transaction signed with the contract account's own key also passes. A genuine promise
/// callback always has exactly one promise result; a direct call has none.
fn require_callback() {
    require!(env::promise_results_count() == 1, "not a callback");
}

pub fn is_sealed_flag() -> bool {
    env::storage_has_key(SEALED_KEY)
}

fn promise_result_bytes() -> Option<Vec<u8>> {
    if env::promise_results_count() != 1 {
        return None;
    }
    match env::promise_result(0) {
        PromiseResult::Successful(b) => Some(b),
        PromiseResult::Failed => None,
    }
}

// ---------------------------------------------------------------- contract

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Dilemma {
    owner: AccountId,
    outlayer_account: AccountId,
    wasm_url: String,
    wasm_hash: String,
    secrets_owner: AccountId,
    secrets_profile: String,
    nearai_signer: String,
    current_season_id: Option<u32>,
    carry_over_yocto: u128,
    agents: LookupMap<AccountId, AgentState>,
    pending_agents: LookupSet<AccountId>,
    seasons: LookupMap<u32, SeasonState>,
    entries: LookupMap<(u32, AccountId), EntryState>,
    entry_stats: LookupMap<(u32, AccountId), EntryStats>,
    entry_order: LookupMap<(u32, u32), AccountId>,
    owner_entries: LookupMap<(u32, AccountId), u32>,
    matches: LookupMap<(u32, AccountId, AccountId), Match>,
    match_order: LookupMap<(u32, u32), (AccountId, AccountId)>,
    claimable: LookupMap<(u32, AccountId), u128>,
    published: LookupMap<(u32, AccountId), PublishedPrompt>,
    published_order: LookupMap<(u32, u32), AccountId>,
    published_count: LookupMap<u32, u32>,
}

#[near]
impl Dilemma {
    #[init]
    pub fn new(
        wasm_url: String,
        wasm_hash: String,
        secrets_owner: AccountId,
        secrets_profile: String,
        nearai_signer: String,
        outlayer_account: AccountId,
    ) -> Self {
        require!(is_hex64(&nearai_signer), "nearai_signer must be 64 lowercase hex");
        require!(!wasm_url.is_empty() && !wasm_hash.is_empty(), "wasm url/hash required");
        Self {
            owner: env::predecessor_account_id(),
            outlayer_account,
            wasm_url,
            wasm_hash,
            secrets_owner,
            secrets_profile,
            nearai_signer,
            current_season_id: None,
            carry_over_yocto: 0,
            agents: LookupMap::new(b"a"),
            pending_agents: LookupSet::new(b"p"),
            seasons: LookupMap::new(b"s"),
            entries: LookupMap::new(b"e"),
            entry_stats: LookupMap::new(b"t"),
            entry_order: LookupMap::new(b"i"),
            owner_entries: LookupMap::new(b"w"),
            matches: LookupMap::new(b"m"),
            match_order: LookupMap::new(b"o"),
            claimable: LookupMap::new(b"c"),
            published: LookupMap::new(b"r"),
            published_order: LookupMap::new(b"q"),
            published_count: LookupMap::new(b"n"),
        }
    }

    // ------------------------------------------------------------ agents

    /// Creates `<name>.<contract>` with 0.2 NEAR and one function-call key limited to
    /// `commit`/`claim` on this contract. The rest of the deposit becomes the agent budget.
    #[payable]
    pub fn register_agent(&mut self, name: String, agent_public_key: PublicKey) -> Promise {
        let owner = env::predecessor_account_id();
        let deposit = env::attached_deposit();
        require!(deposit >= MIN_REGISTER_DEPOSIT, "attach >= 0.25 NEAR");
        require!(valid_agent_name(&name), "invalid name");
        require!(agent_public_key.curve_type() == CurveType::ED25519, "agent key must be ed25519");
        let agent_id: AccountId =
            format!("{}.{}", name, env::current_account_id()).parse().unwrap_or_else(|_| env::panic_str("invalid name"));
        require!(
            !self.agents.contains_key(&agent_id) && !self.pending_agents.contains(&agent_id),
            "name taken"
        );
        self.pending_agents.insert(agent_id.clone());
        Promise::new(agent_id.clone())
            .create_account()
            .transfer(AGENT_ACCOUNT_FUNDING)
            .add_access_key_allowance(
                agent_public_key,
                Allowance::limited(FC_KEY_ALLOWANCE).unwrap(),
                env::current_account_id(),
                AGENT_KEY_METHODS.to_string(),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(REGISTER_CALLBACK_GAS)
                    .on_agent_created(agent_id, owner, name, U128(deposit.as_yoctonear())),
            )
    }

    /// Records the agent after sub-account creation; on failure refunds the whole deposit.
    #[private]
    pub fn on_agent_created(
        &mut self,
        agent_id: AccountId,
        owner: AccountId,
        name: String,
        deposit: U128,
    ) -> Option<AccountId> {
        require_callback();
        self.pending_agents.remove(&agent_id);
        if promise_result_bytes().is_none() {
            log!("register_agent failed for {}; refunding {}", agent_id, deposit.0);
            Promise::new(owner).transfer(NearToken::from_yoctonear(deposit.0));
            return None;
        }
        self.agents.insert(
            agent_id.clone(),
            AgentState {
                name: name.clone(),
                owner: owner.clone(),
                registered_at_ns: env::block_timestamp(),
                budget_yocto: deposit.0 - AGENT_ACCOUNT_FUNDING.as_yoctonear(),
                seasons: vec![],
            },
        );
        emit("agent_registered", json!({"agent_id": agent_id, "owner": owner, "name": name}));
        Some(agent_id)
    }

    #[payable]
    pub fn fund_agent(&mut self, agent_id: AccountId) -> U128 {
        let d = env::attached_deposit().as_yoctonear();
        require!(d > 0, "attach a deposit");
        let a = self.agents.get_mut(&agent_id).unwrap_or_else(|| env::panic_str("unknown agent"));
        a.budget_yocto += d;
        U128(a.budget_yocto)
    }

    #[payable]
    pub fn withdraw(&mut self, agent_id: AccountId, amount_yocto: U128) -> U128 {
        near_sdk::assert_one_yocto();
        let caller = env::predecessor_account_id();
        let a = self.agents.get_mut(&agent_id).unwrap_or_else(|| env::panic_str("unknown agent"));
        require!(a.owner == caller, "not owner");
        require!(amount_yocto.0 <= a.budget_yocto, "amount > budget");
        a.budget_yocto -= amount_yocto.0;
        let left = a.budget_yocto;
        if amount_yocto.0 > 0 {
            Promise::new(caller).transfer(NearToken::from_yoctonear(amount_yocto.0));
        }
        U128(left)
    }

    // ------------------------------------------------------------ seasons

    /// Opens a season (status `pending_key`) and asks the referee WASM for its pubkey.
    /// Returns the new `season_id`; `on_pubkey` moves it to `commit`.
    /// Optional `wasm_url` + `wasm_hash` (together) and `secrets_profile` override the config
    /// for this season only; they are frozen in the season and used by its `play_match` calls.
    /// Any carry-over from earlier seasons is added to the new pool.
    /// After `seal` the overrides are refused: every season uses the config referee.
    #[payable]
    pub fn open_season(
        &mut self,
        params: SeasonParams,
        wasm_url: Option<String>,
        wasm_hash: Option<String>,
        secrets_profile: Option<String>,
    ) -> u32 {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(env::attached_deposit() >= MIN_OUTLAYER_DEPOSIT, "attach >= 0.02 NEAR");
        if let Some(cur) = self.current_season_id {
            let st = self.season(cur).status;
            require!(
                matches!(st, SeasonStatus::Settled | SeasonStatus::Cancelled | SeasonStatus::KeyFailed),
                "previous season not finished"
            );
        }
        let now = env::block_timestamp();
        let p = &params;
        require!(p.commit_deadline_ns.0 > now, "commit_deadline_ns must be in the future");
        require!(p.play_deadline_ns.0 > p.commit_deadline_ns.0, "play_deadline_ns must be after commit deadline");
        require!(p.unit_yocto.0 > 0, "unit_yocto must be > 0");
        require!((2..=MAX_AGENTS).contains(&p.max_agents), "max_agents must be 2..=40");
        require!(p.max_entries_per_owner >= 1, "max_entries_per_owner must be >= 1");
        require!(is_hex64(&p.referee_template_hash), "referee_template_hash must be 64 lowercase hex");
        require!(!p.model.is_empty() && p.model.len() <= 128, "bad model");
        require!(
            !p.prize_split_bps.is_empty()
                && p.prize_split_bps.len() <= p.max_agents as usize
                && p.prize_split_bps.iter().map(|x| *x as u32).sum::<u32>() == 10_000,
            "prize_split_bps must sum to 10000"
        );
        let entry_deposit = p
            .unit_yocto
            .0
            .checked_mul(STAKE_UNITS_PER_MATCH * (p.max_agents as u128 - 1))
            .and_then(|s| s.checked_add(p.bond_yocto.0))
            .unwrap_or_else(|| env::panic_str("deposit overflow"));
        require!(
            !is_sealed_flag() || (wasm_url.is_none() && wasm_hash.is_none() && secrets_profile.is_none()),
            "sealed: per-season wasm_url/wasm_hash/secrets_profile overrides are disabled"
        );
        require!(wasm_url.is_some() == wasm_hash.is_some(), "wasm_url and wasm_hash must be overridden together");
        let wasm = WasmSource {
            url: wasm_url.unwrap_or_else(|| self.wasm_url.clone()),
            hash: wasm_hash.unwrap_or_else(|| self.wasm_hash.clone()),
        };
        require!(!wasm.url.is_empty() && !wasm.hash.is_empty(), "wasm url/hash required");
        let secrets_profile = secrets_profile.unwrap_or_else(|| self.secrets_profile.clone());
        require!(!secrets_profile.is_empty(), "secrets_profile required");
        let carry_in = std::mem::take(&mut self.carry_over_yocto);
        let season_id = self.current_season_id.map(|x| x + 1).unwrap_or(1);
        self.seasons.insert(
            season_id,
            SeasonState {
                season_id,
                status: SeasonStatus::PendingKey,
                params,
                wasm,
                secrets_owner: self.secrets_owner.clone(),
                secrets_profile,
                pubkey: None,
                entry_deposit_yocto: entry_deposit,
                stake_per_agent_yocto: None,
                n_entries: 0,
                total_rounds: 0,
                rounds_scheduled: 0,
                n_matches: 0,
                n_settled: 0,
                n_void: 0,
                pool_yocto: carry_in,
                opened_at_ns: now,
                closed_at_ns: None,
                settled_at_ns: None,
                settle_cursor: 0,
                carry_in_yocto: carry_in,
                carry_over_yocto: 0,
            },
        );
        self.current_season_id = Some(season_id);
        let s = self.season(season_id);
        // Detached promise chain: the call returns the id, on_pubkey stores the key.
        self.outlayer_call(&s, json!({"action": "derive_pubkey", "season": season_id}), PUBKEY_MAX_SECS, Gas::from_tgas(0)).then(
            Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_pubkey(season_id),
        );
        season_id
    }

    #[private]
    pub fn on_pubkey(&mut self, season_id: u32) -> Option<String> {
        require_callback();
        let mut s = self.season(season_id);
        require!(s.status == SeasonStatus::PendingKey, "season not pending_key");
        let pk = promise_result_bytes()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .map(|v| match v {
                Value::String(inner) => serde_json::from_str::<Value>(&inner).unwrap_or(Value::Null),
                other => other,
            })
            .and_then(|v| v.get("pubkey").and_then(|p| p.as_str()).map(str::to_string))
            .filter(|p| valid_pubkey(p));
        match pk {
            Some(pk) => {
                s.pubkey = Some(pk.clone());
                s.status = SeasonStatus::Commit;
                emit(
                    "season_opened",
                    json!({
                        "season_id": season_id,
                        "pubkey": pk,
                        "referee_template_hash": s.params.referee_template_hash,
                        "commit_deadline_ns": s.params.commit_deadline_ns,
                        "entry_deposit_yocto": U128(s.entry_deposit_yocto),
                    }),
                );
                self.seasons.insert(season_id, s);
                Some(pk)
            }
            None => {
                log!("derive_pubkey failed for season {}", season_id);
                s.status = SeasonStatus::KeyFailed;
                self.return_carry(&mut s);
                self.seasons.insert(season_id, s);
                None
            }
        }
    }

    /// One entry per agent per season; debits `entry_deposit_yocto` from the agent budget.
    pub fn commit(
        &mut self,
        season_id: u32,
        agent_id: AccountId,
        ciphertext_hex: String,
        commitment: String,
        family: String,
        parent: Option<Parent>,
    ) {
        let caller = env::predecessor_account_id();
        let mut agent = self.agents.get(&agent_id).cloned().unwrap_or_else(|| env::panic_str("unknown agent"));
        require!(caller == agent_id || caller == agent.owner, "caller must be the agent or its owner");
        let mut s = self.season(season_id);
        require!(s.status == SeasonStatus::Commit, "season not in commit");
        require!(env::block_timestamp() <= s.params.commit_deadline_ns.0, "commit deadline passed");
        let key = (season_id, agent_id.clone());
        require!(!self.entries.contains_key(&key), "agent already entered");
        let okey = (season_id, agent.owner.clone());
        let owner_count = self.owner_entries.get(&okey).copied().unwrap_or(0);
        require!(owner_count < s.params.max_entries_per_owner, "owner reached max_entries_per_owner");
        require!(s.n_entries < s.params.max_agents, "max_agents reached");
        require!(agent.budget_yocto >= s.entry_deposit_yocto, "budget < entry_deposit_yocto");
        require!(
            !ciphertext_hex.is_empty()
                && ciphertext_hex.len() <= MAX_CIPHERTEXT_HEX
                && ciphertext_hex.len() % 2 == 0
                && is_lower_hex(&ciphertext_hex),
            "bad ciphertext_hex"
        );
        require!(is_hex64(&commitment), "bad commitment");
        require!(valid_family(&family), "bad family");
        require!(parent.as_ref().is_none_or(|p| p.season_id >= 1), "parent.season_id must be >= 1");
        let ciphertext = hex::decode(&ciphertext_hex).unwrap();

        agent.budget_yocto -= s.entry_deposit_yocto;
        agent.seasons.push(season_id);
        self.agents.insert(agent_id.clone(), agent.clone());
        self.owner_entries.insert(okey, owner_count + 1);
        self.entry_order.insert((season_id, s.n_entries), agent_id.clone());
        self.entries.insert(
            key.clone(),
            EntryState {
                index: s.n_entries,
                owner: agent.owner,
                family: family.clone(),
                parent: parent.clone(),
                commitment: commitment.clone(),
                ciphertext,
                committed_at_ns: env::block_timestamp(),
            },
        );
        self.entry_stats.insert(key, EntryStats::default());
        s.n_entries += 1;
        self.seasons.insert(season_id, s);
        emit(
            "committed",
            json!({"season_id": season_id, "agent_id": agent_id, "commitment": commitment, "family": family, "parent": parent}),
        );
    }

    /// After the commit deadline: freeze entries, fix the stake, credit the excess deposit.
    pub fn close_commits(&mut self, season_id: u32) -> u32 {
        let mut s = self.season(season_id);
        require!(s.status == SeasonStatus::Commit, "season not in commit");
        require!(env::block_timestamp() > s.params.commit_deadline_ns.0, "commit deadline not reached");
        let n = s.n_entries;
        s.closed_at_ns = Some(env::block_timestamp());
        if n < 2 {
            s.status = SeasonStatus::Cancelled;
            self.return_carry(&mut s);
            for id in self.entry_ids(season_id, n) {
                self.credit(season_id, &id, s.entry_deposit_yocto);
            }
            emit(
                "commits_closed",
                json!({"season_id": season_id, "n_entries": n, "total_rounds": 0, "stake_per_agent_yocto": null}),
            );
        } else {
            let unit = s.params.unit_yocto.0;
            let stake = STAKE_UNITS_PER_MATCH * unit * (n as u128 - 1);
            let excess = s.entry_deposit_yocto - s.params.bond_yocto.0 - stake;
            if excess > 0 {
                for id in self.entry_ids(season_id, n) {
                    self.credit(season_id, &id, excess);
                }
            }
            s.status = SeasonStatus::Play;
            s.stake_per_agent_yocto = Some(stake);
            s.total_rounds = total_rounds(n);
            emit(
                "commits_closed",
                json!({"season_id": season_id, "n_entries": n, "total_rounds": s.total_rounds, "stake_per_agent_yocto": U128(stake)}),
            );
        }
        self.seasons.insert(season_id, s);
        n
    }

    /// Schedules the next circle-method round. Match keys are created only here.
    pub fn schedule_round(&mut self, season_id: u32) -> Vec<MatchKey> {
        let mut s = self.season(season_id);
        require!(s.status == SeasonStatus::Play, "season not in play");
        require!(s.rounds_scheduled < s.total_rounds, "all rounds scheduled");
        let round = s.rounds_scheduled;
        let ids = self.entry_ids(season_id, s.n_entries);
        let mut out = vec![];
        for (x, y) in round_pairs(s.n_entries, round) {
            let (a, b) = ordered(ids[x as usize].clone(), ids[y as usize].clone());
            let key = (season_id, a.clone(), b.clone());
            require!(!self.matches.contains_key(&key), "pair already scheduled");
            self.matches.insert(
                key,
                Match {
                    season_id,
                    match_key: match_key_str(season_id, &a, &b),
                    a: a.clone(),
                    b: b.clone(),
                    round,
                    status: MatchStatus::Scheduled,
                    a_move: None,
                    b_move: None,
                    a_payoff: 0,
                    b_payoff: 0,
                    pool_delta: 0,
                    sig_a_ok: false,
                    sig_b_ok: false,
                    a_chat_id: None,
                    b_chat_id: None,
                    a_signed_text: None,
                    b_signed_text: None,
                    a_sig: None,
                    b_sig: None,
                    void_reason: None,
                    requested_at_block: None,
                    settled_at_block: None,
                },
            );
            self.match_order.insert((season_id, s.n_matches), (a.clone(), b.clone()));
            s.n_matches += 1;
            out.push(MatchKey { season_id, a, b });
        }
        s.rounds_scheduled += 1;
        self.seasons.insert(season_id, s);
        out
    }

    /// One-shot: `scheduled → pending`, then OutLayer runs the pinned referee once.
    #[payable]
    pub fn play_match(&mut self, season_id: u32, a: AccountId, b: AccountId) -> Promise {
        // F2: checked first, before any state change.
        if env::prepaid_gas() < MIN_PLAY_GAS {
            env::panic_str(&format!("insufficient gas: attach at least {} Tgas", MIN_PLAY_GAS.as_tgas()));
        }
        require!(env::attached_deposit() >= MIN_OUTLAYER_DEPOSIT, "attach >= 0.02 NEAR");
        let (a, b) = ordered(a, b);
        let s = self.season(season_id);
        require!(s.status == SeasonStatus::Play, "season not in play");
        let key = (season_id, a.clone(), b.clone());
        let mut m = self.matches.get(&key).cloned().unwrap_or_else(|| env::panic_str("unknown match"));
        require!(m.status == MatchStatus::Scheduled, "match not scheduled");
        let ea = self.entries.get(&(season_id, a.clone())).unwrap();
        let eb = self.entries.get(&(season_id, b.clone())).unwrap();
        let input = json!({
            "action": "play_match",
            "season": season_id,
            "match_key": m.match_key,
            "a": a,
            "b": b,
            "ct_a": hex::encode(&ea.ciphertext),
            "ct_b": hex::encode(&eb.ciphertext),
            "hash_a": ea.commitment,
            "hash_b": eb.commitment,
            "referee_template_hash": s.params.referee_template_hash,
            "params": {
                "model": s.params.model,
                "temperature": 0,
                "seed": LLM_SEED,
                "max_tokens": LLM_MAX_TOKENS,
                "enable_thinking": false,
                "max_prompt_bytes": MAX_PROMPT_BYTES,
            },
        });
        m.status = MatchStatus::Pending;
        m.requested_at_block = Some(env::block_height());
        self.matches.insert(key, m);
        self.outlayer_call(&s, input, MATCH_MAX_SECS, OUTLAYER_PLAY_GAS).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .with_unused_gas_weight(0)
                .on_match(season_id, a, b),
        )
    }

    /// Settles or voids a pending match from the referee output. Never panics on bad output.
    #[private]
    pub fn on_match(&mut self, season_id: u32, a: AccountId, b: AccountId) -> String {
        require_callback();
        let key = (season_id, a.clone(), b.clone());
        let mut m = self.matches.get(&key).cloned().unwrap_or_else(|| env::panic_str("unknown match"));
        require!(m.status == MatchStatus::Pending, "match not pending");
        let mut s = self.season(season_id);
        m.settled_at_block = Some(env::block_height());
        let raw = promise_result_bytes();
        match parse_match_result(raw.as_deref(), &m.match_key) {
            Err(reason) => {
                self.void_match(&mut s, &mut m, &reason);
                self.matches.insert(key, m);
                self.seasons.insert(season_id, s);
                "void".into()
            }
            Ok(o) => {
                let (pa, pb, pool) = payoff(o.a_move, o.b_move);
                m.sig_a_ok = check_sig(&self.nearai_signer, &o.a_signed_text, &o.a_sig);
                m.sig_b_ok = check_sig(&self.nearai_signer, &o.b_signed_text, &o.b_sig);
                m.a_move = Some(o.a_move);
                m.b_move = Some(o.b_move);
                m.a_payoff = pa;
                m.b_payoff = pb;
                m.pool_delta = pool;
                m.a_chat_id = Some(o.a_chat_id);
                m.b_chat_id = Some(o.b_chat_id);
                m.a_signed_text = Some(o.a_signed_text);
                m.b_signed_text = Some(o.b_signed_text);
                m.a_sig = Some(o.a_sig);
                m.b_sig = Some(o.b_sig);
                m.status = MatchStatus::Settled;
                let unit = s.params.unit_yocto.0;
                self.credit(season_id, &a, pa as u128 * unit);
                self.credit(season_id, &b, pb as u128 * unit);
                s.pool_yocto += pool as u128 * unit;
                s.n_settled += 1;
                let owner_a = self.entries.get(&(season_id, a.clone())).unwrap().owner.clone();
                let owner_b = self.entries.get(&(season_id, b.clone())).unwrap().owner.clone();
                let counted = owner_a != owner_b;
                for (id, mv, p) in [(&a, o.a_move, pa), (&b, o.b_move, pb)] {
                    let st = self.entry_stats.get_mut(&(season_id, id.clone())).unwrap();
                    if mv == Move::F {
                        st.forfeited = true;
                    }
                    if counted {
                        st.matches_counted += 1;
                        st.total_payoff_counted += p as u64;
                    }
                }
                emit(
                    "match_played",
                    json!({
                        "season_id": season_id, "a": a, "b": b,
                        "a_move": o.a_move, "b_move": o.b_move,
                        "a_payoff": pa, "b_payoff": pb, "pool_delta": pool,
                        "sig_a_ok": m.sig_a_ok, "sig_b_ok": m.sig_b_ok,
                    }),
                );
                let res = format!("settled {}{}", o.a_move.as_char(), o.b_move.as_char());
                self.matches.insert(key, m);
                self.seasons.insert(season_id, s);
                res
            }
        }
    }

    /// `void` (or `pending` for more than 250 blocks) → `refunded`; 3 units back to each side.
    pub fn refund_void(&mut self, season_id: u32, a: AccountId, b: AccountId) -> U128 {
        let (a, b) = ordered(a, b);
        let key = (season_id, a.clone(), b.clone());
        let mut m = self.matches.get(&key).cloned().unwrap_or_else(|| env::panic_str("unknown match"));
        let mut s = self.season(season_id);
        match m.status {
            MatchStatus::Void => {}
            MatchStatus::Pending
                if env::block_height() > m.requested_at_block.unwrap_or(0) + STALE_PENDING_BLOCKS =>
            {
                m.settled_at_block = Some(env::block_height());
                self.void_match(&mut s, &mut m, "stale_pending");
            }
            _ => env::panic_str("match not void"),
        }
        let refund = self.refund(&s, &mut m);
        self.matches.insert(key, m);
        self.seasons.insert(season_id, s);
        U128(refund)
    }

    /// Ranks by average payoff vs distinct owners, pays the pool, returns bonds.
    ///
    /// After the play deadline, unfinished (`scheduled`/`pending`) matches are voided and refunded
    /// in batches of `SETTLE_VOID_BATCH` (receipt log limit). While matches remain to be voided the
    /// call returns `[]` and the season stays `play`; call again until it returns the ranking.
    pub fn settle_season(&mut self, season_id: u32) -> Vec<LeaderboardRow> {
        let mut s = self.season(season_id);
        require!(s.status == SeasonStatus::Play, "season not in play");
        let open_matches = s.n_matches - s.n_settled - s.n_void;
        let unfinished = open_matches > 0 || s.rounds_scheduled < s.total_rounds;
        let now = env::block_timestamp();
        require!(!unfinished || now >= s.params.play_deadline_ns.0, "unfinished matches before play deadline");
        let unit = s.params.unit_yocto.0;

        // Unfinished (scheduled / pending) at the deadline: void and refund now.
        // Already-void matches stay `void` until someone calls `refund_void` (works after settle too).
        let mut voided = 0u32;
        while s.n_matches - s.n_settled - s.n_void > 0 && voided < SETTLE_VOID_BATCH {
            let i = s.settle_cursor;
            s.settle_cursor += 1;
            let (a, b) = self.match_order.get(&(season_id, i)).cloned().unwrap();
            let key = (season_id, a, b);
            let mut m = self.matches.get(&key).cloned().unwrap();
            if matches!(m.status, MatchStatus::Scheduled | MatchStatus::Pending) {
                m.settled_at_block = Some(env::block_height());
                self.void_match(&mut s, &mut m, "deadline");
                self.refund(&s, &mut m);
                self.matches.insert(key, m);
                voided += 1;
            }
        }
        if s.n_matches - s.n_settled - s.n_void > 0 || voided > SETTLE_FINAL_MAX_VOIDS {
            log!("settle_season: {} matches voided; call settle_season again to finish", voided);
            self.seasons.insert(season_id, s);
            return vec![];
        }
        let ids = self.entry_ids(season_id, s.n_entries);
        // Stake for rounds that were never scheduled goes back.
        if s.rounds_scheduled < s.total_rounds {
            for (i, id) in ids.iter().enumerate() {
                let played = matches_in_rounds(s.n_entries, i as u32, s.rounds_scheduled);
                let missing = (s.n_entries - 1 - played) as u128;
                if missing > 0 {
                    self.credit(season_id, id, missing * STAKE_UNITS_PER_MATCH * unit);
                }
            }
        }
        // Bonds: forfeited ones go to the pool, the rest are returned.
        let bond = s.params.bond_yocto.0;
        let stats: Vec<EntryStats> =
            ids.iter().map(|id| self.entry_stats.get(&(season_id, id.clone())).cloned().unwrap()).collect();
        for (id, st) in ids.iter().zip(stats.iter()) {
            if st.forfeited {
                s.pool_yocto += bond;
            } else {
                self.credit(season_id, id, bond);
            }
        }
        // Ranking and prizes.
        let order = rank(
            &stats
                .iter()
                .map(|st| RankInput { matches_counted: st.matches_counted, total_payoff_counted: st.total_payoff_counted })
                .collect::<Vec<_>>(),
        );
        let mut ranking = vec![];
        let mut paid = 0u128;
        for (idx, r) in order {
            let id = &ids[idx];
            let prize_yocto = prize(s.pool_yocto, &s.params.prize_split_bps, r);
            paid += prize_yocto;
            if prize_yocto > 0 {
                self.credit(season_id, id, prize_yocto);
            }
            let st = self.entry_stats.get_mut(&(season_id, id.clone())).unwrap();
            st.rank = r;
            st.avg_payoff_milli = r.map(|_| avg_milli(st.total_payoff_counted, st.matches_counted));
            st.prize_yocto = prize_yocto;
            ranking.push(json!({
                "agent_id": id,
                "rank": r,
                "avg_payoff_milli": avg_milli(st.total_payoff_counted, st.matches_counted),
                "prize_yocto": U128(prize_yocto),
            }));
        }
        // Rounding dust and unfilled prize slots roll into the next season's pool.
        s.carry_over_yocto = s.pool_yocto - paid;
        self.carry_over_yocto += s.carry_over_yocto;
        s.status = SeasonStatus::Settled;
        s.settled_at_ns = Some(now);
        emit("season_settled", json!({"season_id": season_id, "pool_yocto": U128(s.pool_yocto), "ranking": ranking}));
        self.seasons.insert(season_id, s);
        self.get_leaderboard(season_id)
    }

    /// Moves the agent's claimable balance for the season into its budget.
    pub fn claim(&mut self, season_id: u32, agent_id: AccountId) -> U128 {
        let caller = env::predecessor_account_id();
        let agent = self.agents.get_mut(&agent_id).unwrap_or_else(|| env::panic_str("unknown agent"));
        require!(caller == agent_id || caller == agent.owner, "caller must be the agent or its owner");
        let key = (season_id, agent_id);
        let amount = self.claimable.get(&key).copied().unwrap_or(0);
        require!(amount > 0, "nothing claimable");
        agent.budget_yocto += amount;
        self.claimable.remove(&key);
        U128(amount)
    }

    /// Optional post-season reveal, checked against the salted commitment.
    pub fn publish_prompt(&mut self, season_id: u32, agent_id: AccountId, prompt: String, salt: String) {
        let agent = self.agents.get(&agent_id).unwrap_or_else(|| env::panic_str("unknown agent"));
        require!(env::predecessor_account_id() == agent.owner, "not owner");
        require!(self.season(season_id).status == SeasonStatus::Settled, "season not settled");
        let e = self.entries.get(&(season_id, agent_id.clone())).unwrap_or_else(|| env::panic_str("no entry"));
        require!(prompt.len() <= MAX_PROMPT_BYTES, "prompt too long");
        require!(is_hex64(&salt), "salt must be 64 lowercase hex");
        let salt_bytes = hex::decode(&salt).unwrap();
        let h = hex::encode(env::sha256(&commitment_preimage(&prompt, &salt_bytes, agent_id.as_str())));
        require!(h == e.commitment, "commitment mismatch");
        let commitment = e.commitment.clone();
        emit("prompt_published", json!({"season_id": season_id, "agent_id": agent_id, "commitment": commitment}));
        let pkey = (season_id, agent_id.clone());
        if !self.published.contains_key(&pkey) {
            let n = self.published_count.get(&season_id).copied().unwrap_or(0);
            self.published_order.insert((season_id, n), agent_id.clone());
            self.published_count.insert(season_id, n + 1);
        }
        self.published.insert(
            pkey,
            PublishedPrompt { agent_id, prompt, salt, commitment },
        );
    }

    // ------------------------------------------------------------ secrets ref (until seal)

    /// Owner only, exactly 1 yocto, refused after `seal` (one way). Points the config referee at
    /// the OutLayer secrets row `owner/profile` used by every season opened from now on (running
    /// and past seasons keep the ref pinned at their `open_season`). Meant to move the profile to
    /// one owned by the contract account itself, so that once `seal` deletes the contract's keys
    /// nobody can re-store, re-scope or delete the season secrets (attacks/RESULTS.md
    /// "secrets-owner"). The contract cannot check the row exists: verify with the keystore view
    /// `list_user_secrets({account_id: owner})` before calling.
    #[payable]
    pub fn set_secrets(&mut self, owner: AccountId, profile: String) {
        near_sdk::assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(!is_sealed_flag(), "sealed: the secrets ref is frozen");
        require!(
            !profile.is_empty()
                && profile.len() <= 64
                && profile.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            "profile must match ^[A-Za-z0-9_-]{1,64}$"
        );
        emit(
            "secrets_set",
            json!({"owner": owner, "profile": profile, "previous_owner": self.secrets_owner, "previous_profile": self.secrets_profile}),
        );
        self.secrets_owner = owner;
        self.secrets_profile = profile;
    }

    // ------------------------------------------------------------ seal (one way)

    /// Owner only, exactly 1 yocto, `confirm == "SEAL-FOREVER"`. Deletes every listed access key
    /// of the contract account (pass the full `view_access_key_list`; the contract cannot
    /// enumerate its keys) in one batch, then `on_sealed` sets the permanent flag. If any listed
    /// key does not exist the batch fails, no key is deleted and the contract stays unsealed.
    /// An empty list seals immediately (for keys already deleted by hand). Irreversible: the
    /// code has no upgrade or unseal path, so with zero keys the code can never change again.
    #[payable]
    pub fn seal(&mut self, public_keys: Vec<PublicKey>, confirm: String) -> PromiseOrValue<bool> {
        near_sdk::assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(confirm == SEAL_CONFIRM, "confirm must be \"SEAL-FOREVER\"");
        require!(!is_sealed_flag(), "already sealed");
        require!(public_keys.len() <= MAX_SEAL_KEYS, "too many keys");
        for (i, k) in public_keys.iter().enumerate() {
            require!(!public_keys[..i].contains(k), "duplicate key");
        }
        if public_keys.is_empty() {
            return PromiseOrValue::Value(self.mark_sealed(vec![]));
        }
        let mut p = Promise::new(env::current_account_id());
        for k in &public_keys {
            p = p.delete_key(k.clone());
        }
        let keys: Vec<String> = public_keys.iter().map(String::from).collect();
        p.then(Self::ext(env::current_account_id()).with_static_gas(SEAL_CALLBACK_GAS).on_sealed(keys)).into()
    }

    /// Sets the seal flag once the key-deletion batch succeeded.
    #[private]
    pub fn on_sealed(&mut self, public_keys: Vec<String>) -> bool {
        require_callback();
        if promise_result_bytes().is_none() {
            log!("seal aborted: deleting the listed access keys failed; contract NOT sealed");
            return false;
        }
        if is_sealed_flag() {
            return true;
        }
        self.mark_sealed(public_keys)
    }

    pub fn is_sealed(&self) -> bool {
        is_sealed_flag()
    }

    // ------------------------------------------------------------ views

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            outlayer_account: self.outlayer_account.clone(),
            wasm_url: self.wasm_url.clone(),
            wasm_hash: self.wasm_hash.clone(),
            secrets_owner: self.secrets_owner.clone(),
            secrets_profile: self.secrets_profile.clone(),
            nearai_signer: self.nearai_signer.clone(),
            current_season_id: self.current_season_id,
            carry_over_yocto: U128(self.carry_over_yocto),
        }
    }

    pub fn get_season(&self, season_id: u32) -> Option<Season> {
        self.seasons.get(&season_id).map(|s| Season {
            season_id: s.season_id,
            status: s.status,
            params: s.params.clone(),
            wasm: s.wasm.clone(),
            secrets_profile: s.secrets_profile.clone(),
            pubkey: s.pubkey.clone(),
            entry_deposit_yocto: U128(s.entry_deposit_yocto),
            stake_per_agent_yocto: s.stake_per_agent_yocto.map(U128),
            n_entries: s.n_entries,
            total_rounds: s.total_rounds,
            rounds_scheduled: s.rounds_scheduled,
            n_matches: s.n_matches,
            n_settled: s.n_settled,
            n_void: s.n_void,
            pool_yocto: U128(s.pool_yocto),
            carry_in_yocto: U128(s.carry_in_yocto),
            carry_over_yocto: U128(s.carry_over_yocto),
            opened_at_ns: U64(s.opened_at_ns),
            closed_at_ns: s.closed_at_ns.map(U64),
            settled_at_ns: s.settled_at_ns.map(U64),
        })
    }

    pub fn get_season_pubkey(&self, season_id: u32) -> Option<String> {
        self.seasons.get(&season_id).and_then(|s| s.pubkey.clone())
    }

    pub fn get_entries(&self, season_id: u32, from_index: Option<u32>, limit: Option<u32>) -> Vec<Entry> {
        let Some(s) = self.seasons.get(&season_id) else { return vec![] };
        let (from, limit) = page(from_index, limit);
        (from..s.n_entries.min(from.saturating_add(limit)))
            .map(|i| {
                let id = self.entry_order.get(&(season_id, i)).unwrap().clone();
                let e = self.entries.get(&(season_id, id.clone())).unwrap();
                Entry {
                    season_id,
                    agent_id: id,
                    owner: e.owner.clone(),
                    family: e.family.clone(),
                    parent: e.parent.clone(),
                    commitment: e.commitment.clone(),
                    ciphertext_hex: hex::encode(&e.ciphertext),
                    committed_at_ns: U64(e.committed_at_ns),
                }
            })
            .collect()
    }

    pub fn get_matches(
        &self,
        season_id: u32,
        from_index: Option<u32>,
        limit: Option<u32>,
        status: Option<MatchStatus>,
    ) -> Vec<Match> {
        let Some(s) = self.seasons.get(&season_id) else { return vec![] };
        let (from, limit) = page(from_index, limit);
        (0..s.n_matches)
            .map(|i| {
                let (a, b) = self.match_order.get(&(season_id, i)).cloned().unwrap();
                self.matches.get(&(season_id, a, b)).cloned().unwrap()
            })
            .filter(|m| status.is_none_or(|st| m.status == st))
            .skip(from as usize)
            .take(limit as usize)
            .collect()
    }

    /// Live while playing (prize `0`); final (stored ranks and prizes) after settlement.
    pub fn get_leaderboard(&self, season_id: u32) -> Vec<LeaderboardRow> {
        let Some(s) = self.seasons.get(&season_id) else { return vec![] };
        let ids = self.entry_ids(season_id, s.n_entries);
        let stats: Vec<EntryStats> =
            ids.iter().map(|id| self.entry_stats.get(&(season_id, id.clone())).cloned().unwrap()).collect();
        let order = rank(
            &stats
                .iter()
                .map(|st| RankInput { matches_counted: st.matches_counted, total_payoff_counted: st.total_payoff_counted })
                .collect::<Vec<_>>(),
        );
        let settled = s.status == SeasonStatus::Settled;
        order
            .into_iter()
            .map(|(idx, r)| {
                let id = &ids[idx];
                let e = self.entries.get(&(season_id, id.clone())).unwrap();
                let st = &stats[idx];
                LeaderboardRow {
                    agent_id: id.clone(),
                    owner: e.owner.clone(),
                    family: e.family.clone(),
                    matches_counted: st.matches_counted,
                    total_payoff_counted: st.total_payoff_counted,
                    avg_payoff_milli: avg_milli(st.total_payoff_counted, st.matches_counted),
                    rank: if settled { st.rank } else { r },
                    prize_yocto: U128(if settled { st.prize_yocto } else { 0 }),
                }
            })
            .collect()
    }

    pub fn get_agent(&self, agent_id: AccountId) -> Option<Agent> {
        self.agents.get(&agent_id).map(|a| Agent {
            agent_id: agent_id.clone(),
            name: a.name.clone(),
            owner: a.owner.clone(),
            registered_at_ns: U64(a.registered_at_ns),
            budget_yocto: U128(a.budget_yocto),
            seasons: a.seasons.clone(),
        })
    }

    pub fn get_lineage(&self, agent_id: AccountId) -> Vec<LineageEntry> {
        let Some(a) = self.agents.get(&agent_id) else { return vec![] };
        a.seasons
            .iter()
            .filter_map(|sid| {
                let key = (*sid, agent_id.clone());
                let e = self.entries.get(&key)?;
                let st = self.entry_stats.get(&key).cloned().unwrap_or_default();
                Some(LineageEntry {
                    season_id: *sid,
                    agent_id: agent_id.clone(),
                    commitment: e.commitment.clone(),
                    family: e.family.clone(),
                    parent: e.parent.clone(),
                    rank: st.rank,
                    avg_payoff_milli: st.avg_payoff_milli,
                })
            })
            .collect()
    }

    /// Prompts revealed via `publish_prompt`, in publish order (first publish; re-publishing is idempotent).
    pub fn get_published_prompts(
        &self,
        season_id: u32,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<PublishedPrompt> {
        let n = self.published_count.get(&season_id).copied().unwrap_or(0);
        let (from, limit) = page(from_index, limit);
        (from..n.min(from.saturating_add(limit)))
            .map(|i| {
                let id = self.published_order.get(&(season_id, i)).unwrap().clone();
                self.published.get(&(season_id, id)).unwrap().clone()
            })
            .collect()
    }

    pub fn get_claimable(&self, season_id: u32, agent_id: AccountId) -> U128 {
        U128(self.claimable.get(&(season_id, agent_id)).copied().unwrap_or(0))
    }
}

fn page(from_index: Option<u32>, limit: Option<u32>) -> (u32, u32) {
    (from_index.unwrap_or(0), limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT))
}

impl Dilemma {
    fn mark_sealed(&mut self, keys_deleted: Vec<String>) -> bool {
        env::storage_write(SEALED_KEY, &env::block_height().to_le_bytes());
        emit("contract_sealed", json!({"keys_deleted": keys_deleted, "block": env::block_height()}));
        true
    }

    fn season(&self, season_id: u32) -> SeasonState {
        self.seasons.get(&season_id).cloned().unwrap_or_else(|| env::panic_str("unknown season"))
    }

    fn entry_ids(&self, season_id: u32, n: u32) -> Vec<AccountId> {
        (0..n).map(|i| self.entry_order.get(&(season_id, i)).cloned().unwrap()).collect()
    }

    /// A season that never plays (key_failed / cancelled) hands its carry-in back.
    fn return_carry(&mut self, s: &mut SeasonState) {
        s.pool_yocto -= s.carry_in_yocto;
        s.carry_over_yocto = s.carry_in_yocto;
        self.carry_over_yocto += s.carry_in_yocto;
    }

    fn credit(&mut self, season_id: u32, agent_id: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let key = (season_id, agent_id.clone());
        let cur = self.claimable.get(&key).copied().unwrap_or(0);
        self.claimable.insert(key, cur + amount);
    }

    fn void_match(&mut self, s: &mut SeasonState, m: &mut Match, reason: &str) {
        m.status = MatchStatus::Void;
        m.void_reason = Some(reason.to_string());
        s.n_void += 1;
        emit("match_void", json!({"season_id": m.season_id, "a": m.a, "b": m.b, "reason": reason}));
    }

    /// `void → refunded`: 3 units back to each side. Returns the per-side amount.
    fn refund(&mut self, s: &SeasonState, m: &mut Match) -> u128 {
        let per_side = STAKE_UNITS_PER_MATCH * s.params.unit_yocto.0;
        m.status = MatchStatus::Refunded;
        let (a, b) = (m.a.clone(), m.b.clone());
        self.credit(s.season_id, &a, per_side);
        self.credit(s.season_id, &b, per_side);
        per_side
    }

    fn outlayer_call(&self, s: &SeasonState, input: Value, max_secs: u64, static_gas: Gas) -> Promise {
        let args = json!({
            "source": {"WasmUrl": {"url": s.wasm.url, "hash": s.wasm.hash, "build_target": "wasm32-wasip2"}},
            "resource_limits": {"max_instructions": 20_000_000_000u64, "max_memory_mb": 128, "max_execution_seconds": max_secs},
            "input_data": input.to_string(),
            "secrets_ref": {"profile": s.secrets_profile, "account_id": s.secrets_owner},
            "response_format": "Json",
            "payer_account_id": env::predecessor_account_id(),
        });
        Promise::new(self.outlayer_account.clone()).function_call_weight(
            "request_execution".into(),
            args.to_string().into_bytes(),
            env::attached_deposit(),
            static_gas,
            GasWeight(1),
        )
    }
}

#[cfg(test)]
mod tests;
