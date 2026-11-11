//! Open Source Dilemma strategy cards: a NEP-245 multi-token contract, separate from the core
//! `dilemma` contract (which stays untouched).
//!
//! After a season settles, the keeper (contract owner) reads the core contract's views
//! (`get_season`, `get_leaderboard`, `get_entries`, `get_lineage`) and calls
//! `mint_season_cards` with one row per entry:
//! * card `s<season>:<agent_id>`: supply 1, minted to the entry owner, with on-chain metadata
//!   (family, rank, avg payoff, commitment, parent card, core contract, settle tx);
//! * badge `badge:s<season>`: one unit per participant entry, minted to each entry owner.
//!
//! NEP-245 core: `mt_transfer`, `mt_batch_transfer`, `mt_transfer_call`,
//! `mt_batch_transfer_call`, `mt_balance_of`, `mt_batch_balance_of`, `mt_supply`,
//! `mt_batch_supply`, `mt_token`, plus `mt_mint` / `mt_transfer` events (nep245 1.0.0).
//! Approvals are not supported (`approval(s)` must be null). The contract pays storage.
//!
//! `seal` (interfaces-v5) is one way: it deletes the cards account's access keys, so the code
//! can never change again. The contract has no owner/minter setter, so the minter stays the
//! init `owner`; minting remains owner-only after seal (it does not check the core contract).
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseOrValue, PromiseResult, PublicKey,
};
use serde_json::json;

pub type TokenId = String;

pub const SPEC: &str = "mt-1.0.0";
pub const MAX_MINT_BATCH: usize = 50;
pub const MAX_FAMILY_LEN: usize = 32;
pub const MAX_COMMITMENT_LEN: usize = 128;
pub const MAX_TX_LEN: usize = 64;
const MAX_LIMIT: u32 = 200;
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(15);
const GAS_FOR_TRANSFER_CALL: Gas = Gas::from_tgas(30);
/// Raw storage key of the one-way seal flag (outside the state struct: no migration needed).
pub const SEALED_KEY: &[u8] = b"__cards_sealed";
pub const SEAL_CONFIRM: &str = "SEAL-FOREVER";
pub const MAX_SEAL_KEYS: usize = 32;
const SEAL_CALLBACK_GAS: Gas = Gas::from_tgas(10);

pub fn card_token_id(season_id: u32, agent_id: &AccountId) -> TokenId {
    format!("s{season_id}:{agent_id}")
}

pub fn badge_token_id(season_id: u32) -> TokenId {
    format!("badge:s{season_id}")
}

// ---------------------------------------------------------------- types

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Tokens,
    TokenIds,
    Balances,
    OwnerTokens,
    AgentCards,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ParentRef {
    pub season_id: u32,
    pub agent_id: AccountId,
}

/// One row of `mint_season_cards`, built off-chain from the core contract's views.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct CardInput {
    pub agent_id: AccountId,
    /// Entry owner (receives the card and one badge unit).
    pub owner: AccountId,
    /// Strategy family; "unknown" when not known.
    pub family: String,
    pub rank: Option<u32>,
    pub avg_payoff_milli: Option<u64>,
    pub commitment: String,
    pub parent: Option<ParentRef>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TokenKind {
    Card,
    Badge,
}

/// On-chain token metadata. Card-only fields are null on badges.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CardMetadata {
    pub kind: TokenKind,
    pub title: String,
    pub season_id: u32,
    pub core_contract: AccountId,
    pub settle_tx: Option<String>,
    pub agent_id: Option<AccountId>,
    pub family: Option<String>,
    pub rank: Option<u32>,
    pub avg_payoff_milli: Option<u64>,
    pub commitment: Option<String>,
    /// Token id of the parent entry's card, when the parent was itself carded.
    pub parent_card: Option<TokenId>,
    pub minted_at_ns: U64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct TokenState {
    pub supply: u128,
    /// Current holder of a supply-1 card; None for badges.
    pub owner_id: Option<AccountId>,
    pub metadata: CardMetadata,
}

/// NEP-245 `Token` (+ `supply` and `metadata`).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Token {
    pub token_id: TokenId,
    pub owner_id: Option<AccountId>,
    pub supply: U128,
    pub metadata: CardMetadata,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct MtContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub owner: AccountId,
    pub core_contract: AccountId,
    pub n_tokens: u32,
}

#[ext_contract(ext_mt_receiver)]
pub trait MultiTokenReceiver {
    fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>>;
}

#[ext_contract(ext_self)]
pub trait SelfResolver {
    fn mt_resolve_transfer(
        &mut self,
        previous_owner_ids: Vec<AccountId>,
        receiver_id: AccountId,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<Vec<(AccountId, u64, U128)>>>>,
    ) -> Vec<U128>;
    fn on_sealed(&mut self, public_keys: Vec<String>) -> bool;
}

// ---------------------------------------------------------------- events

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "nep245", "version": "1.0.0", "event": event, "data": data})
    ));
}

fn emit_osd(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "osd", "version": "1.0.0", "event": event, "data": [data]})
    ));
}

/// `#[private]` alone also accepts a tx signed with this account's own key; a genuine promise
/// callback always carries exactly one promise result.
fn require_callback() {
    require!(env::promise_results_count() == 1, "not a callback");
}

fn is_sealed_flag() -> bool {
    env::storage_has_key(SEALED_KEY)
}

fn amounts_json(a: &[u128]) -> Vec<String> {
    a.iter().map(|x| x.to_string()).collect()
}

// ---------------------------------------------------------------- contract

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Cards {
    owner: AccountId,
    core_contract: AccountId,
    tokens: LookupMap<TokenId, TokenState>,
    token_ids: Vector<TokenId>,
    balances: LookupMap<(TokenId, AccountId), u128>,
    owner_tokens: LookupMap<AccountId, Vec<TokenId>>,
    agent_cards: LookupMap<AccountId, Vec<TokenId>>,
}

#[near]
impl Cards {
    #[init]
    pub fn new(owner_id: AccountId, core_contract: AccountId) -> Self {
        Self {
            owner: owner_id,
            core_contract,
            tokens: LookupMap::new(Key::Tokens),
            token_ids: Vector::new(Key::TokenIds),
            balances: LookupMap::new(Key::Balances),
            owner_tokens: LookupMap::new(Key::OwnerTokens),
            agent_cards: LookupMap::new(Key::AgentCards),
        }
    }

    // ------------------------------------------------------------ mint (owner only)

    /// Mints one card per row and one badge unit per row for `season_id`. Owner only.
    /// Rows whose card already exists panic (the ops script skips them), so a failed batch can be
    /// retried. Returns the minted card token ids.
    pub fn mint_season_cards(&mut self, season_id: u32, cards: Vec<CardInput>, settle_tx: Option<String>) -> Vec<TokenId> {
        require!(env::predecessor_account_id() == self.owner, "only the owner can mint");
        require!(!cards.is_empty() && cards.len() <= MAX_MINT_BATCH, "cards: 1..=50 rows per call");
        if let Some(tx) = &settle_tx {
            require!(!tx.is_empty() && tx.len() <= MAX_TX_LEN && tx.chars().all(|c| c.is_ascii_alphanumeric()), "bad settle_tx");
        }
        let now = U64(env::block_timestamp());
        let badge_id = badge_token_id(season_id);
        if !self.tokens.contains_key(&badge_id) {
            let metadata = CardMetadata {
                kind: TokenKind::Badge,
                title: format!("OSD season {season_id} participant"),
                season_id,
                core_contract: self.core_contract.clone(),
                settle_tx: settle_tx.clone(),
                agent_id: None,
                family: None,
                rank: None,
                avg_payoff_milli: None,
                commitment: None,
                parent_card: None,
                minted_at_ns: now,
            };
            self.tokens.insert(badge_id.clone(), TokenState { supply: 0, owner_id: None, metadata });
            self.token_ids.push(badge_id.clone());
        } else if settle_tx.is_some() {
            let b = self.tokens.get_mut(&badge_id).unwrap();
            if b.metadata.settle_tx.is_none() {
                b.metadata.settle_tx = settle_tx.clone();
            }
        }

        // owner -> (token_ids, amounts) for one mt_mint event entry per owner, in first-seen order.
        let mut by_owner: Vec<(AccountId, Vec<TokenId>, Vec<u128>)> = Vec::new();
        let mut minted = Vec::with_capacity(cards.len());
        for c in cards {
            require!(!c.family.is_empty() && c.family.len() <= MAX_FAMILY_LEN, "bad family");
            require!(c.commitment.len() <= MAX_COMMITMENT_LEN, "commitment too long");
            if let Some(p) = &c.parent {
                require!(p.season_id < season_id, "parent must be from an earlier season");
            }
            let id = card_token_id(season_id, &c.agent_id);
            require!(!self.tokens.contains_key(&id), format!("card {id} already minted"));
            let parent_card = c
                .parent
                .as_ref()
                .map(|p| card_token_id(p.season_id, &p.agent_id))
                .filter(|pid| self.tokens.contains_key(pid));
            let metadata = CardMetadata {
                kind: TokenKind::Card,
                title: format!("{} · season {season_id}", c.agent_id),
                season_id,
                core_contract: self.core_contract.clone(),
                settle_tx: settle_tx.clone(),
                agent_id: Some(c.agent_id.clone()),
                family: Some(c.family),
                rank: c.rank,
                avg_payoff_milli: c.avg_payoff_milli,
                commitment: Some(c.commitment),
                parent_card,
                minted_at_ns: now,
            };
            self.tokens.insert(id.clone(), TokenState { supply: 1, owner_id: Some(c.owner.clone()), metadata });
            self.token_ids.push(id.clone());
            self.agent_cards.entry(c.agent_id.clone()).or_default().push(id.clone());
            self.add_balance(&id, &c.owner, 1);
            self.tokens.get_mut(&badge_id).unwrap().supply += 1;
            self.add_balance(&badge_id, &c.owner, 1);

            match by_owner.iter_mut().find(|(o, _, _)| *o == c.owner) {
                Some((_, ids, amts)) => {
                    ids.push(id.clone());
                    amts.push(1);
                    if let Some(i) = ids.iter().position(|t| *t == badge_id) {
                        amts[i] += 1;
                    }
                }
                None => by_owner.push((c.owner.clone(), vec![id.clone(), badge_id.clone()], vec![1, 1])),
            }
            minted.push(id);
        }
        emit(
            "mt_mint",
            json!(by_owner
                .iter()
                .map(|(o, ids, amts)| json!({"owner_id": o, "token_ids": ids, "amounts": amounts_json(amts), "memo": format!("season {season_id}")}))
                .collect::<Vec<_>>()),
        );
        minted
    }

    // ------------------------------------------------------------ NEP-245 core: transfers

    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    ) {
        near_sdk::assert_one_yocto();
        require!(approval.is_none(), "approvals are not supported");
        let sender = env::predecessor_account_id();
        self.internal_batch_transfer(&sender, &receiver_id, &[token_id], &[amount.0], memo);
    }

    #[payable]
    pub fn mt_batch_transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
    ) {
        near_sdk::assert_one_yocto();
        require!(approvals.is_none_or(|a| a.iter().all(Option::is_none)), "approvals are not supported");
        let sender = env::predecessor_account_id();
        let amounts: Vec<u128> = amounts.iter().map(|a| a.0).collect();
        self.internal_batch_transfer(&sender, &receiver_id, &token_ids, &amounts, memo);
    }

    #[payable]
    pub fn mt_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        near_sdk::assert_one_yocto();
        require!(approval.is_none(), "approvals are not supported");
        self.transfer_call(receiver_id, vec![token_id], vec![amount], memo, msg)
    }

    #[payable]
    pub fn mt_batch_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        near_sdk::assert_one_yocto();
        require!(approvals.is_none_or(|a| a.iter().all(Option::is_none)), "approvals are not supported");
        self.transfer_call(receiver_id, token_ids, amounts, memo, msg)
    }

    /// Returns the amounts actually transferred (NEP-245); refunds the unused part to the sender.
    #[private]
    pub fn mt_resolve_transfer(
        &mut self,
        previous_owner_ids: Vec<AccountId>,
        receiver_id: AccountId,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        #[allow(unused_variables)] approvals: Option<Vec<Option<Vec<(AccountId, u64, U128)>>>>,
    ) -> Vec<U128> {
        require_callback();
        let unused: Vec<u128> = match env::promise_result(0) {
            PromiseResult::Successful(v) => match serde_json::from_slice::<Vec<U128>>(&v) {
                Ok(r) if r.len() == amounts.len() => r.iter().zip(&amounts).map(|(u, a)| u.0.min(a.0)).collect(),
                _ => amounts.iter().map(|a| a.0).collect(),
            },
            PromiseResult::Failed => amounts.iter().map(|a| a.0).collect(),
        };
        let sender = previous_owner_ids[0].clone();
        let mut refund_ids = Vec::new();
        let mut refund_amts = Vec::new();
        let mut used = Vec::with_capacity(amounts.len());
        for ((id, amt), want) in token_ids.iter().zip(&amounts).zip(unused) {
            let refund = want.min(self.balance(id, &receiver_id));
            if refund > 0 {
                self.sub_balance(id, &receiver_id, refund);
                self.add_balance(id, &sender, refund);
                self.update_card_owner(id, &sender);
                refund_ids.push(id.clone());
                refund_amts.push(refund);
            }
            used.push(U128(amt.0 - refund));
        }
        if !refund_ids.is_empty() {
            emit(
                "mt_transfer",
                json!([{"old_owner_id": receiver_id, "new_owner_id": sender, "token_ids": refund_ids, "amounts": amounts_json(&refund_amts), "memo": "refund"}]),
            );
        }
        used
    }

    // ------------------------------------------------------------ seal (one way)

    /// Owner only, exactly 1 yocto, `confirm == "SEAL-FOREVER"`. Deletes the listed access keys
    /// of this account (pass the full `view_access_key_list`) in one batch; `on_sealed` sets the
    /// permanent flag only if the batch succeeded. An empty list seals immediately.
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
            return PromiseOrValue::Value(Self::mark_sealed(vec![]));
        }
        let mut p = Promise::new(env::current_account_id());
        for k in &public_keys {
            p = p.delete_key(k.clone());
        }
        let keys: Vec<String> = public_keys.iter().map(String::from).collect();
        p.then(ext_self::ext(env::current_account_id()).with_static_gas(SEAL_CALLBACK_GAS).on_sealed(keys)).into()
    }

    #[private]
    pub fn on_sealed(&mut self, public_keys: Vec<String>) -> bool {
        require_callback();
        if !matches!(env::promise_result(0), PromiseResult::Successful(_)) {
            env::log_str("seal aborted: deleting the listed access keys failed; contract NOT sealed");
            return false;
        }
        is_sealed_flag() || Self::mark_sealed(public_keys)
    }

    pub fn is_sealed(&self) -> bool {
        is_sealed_flag()
    }

    // ------------------------------------------------------------ NEP-245 core: views

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: TokenId) -> U128 {
        U128(self.balance(&token_id, &account_id))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<TokenId>) -> Vec<U128> {
        token_ids.iter().map(|t| U128(self.balance(t, &account_id))).collect()
    }

    pub fn mt_supply(&self, token_id: TokenId) -> Option<U128> {
        self.tokens.get(&token_id).map(|t| U128(t.supply))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<TokenId>) -> Vec<Option<U128>> {
        token_ids.into_iter().map(|t| self.mt_supply(t)).collect()
    }

    pub fn mt_token(&self, token_ids: Vec<TokenId>) -> Vec<Option<Token>> {
        token_ids.into_iter().map(|t| self.token(&t)).collect()
    }

    pub fn mt_metadata_contract(&self) -> MtContractMetadata {
        MtContractMetadata { spec: SPEC.into(), name: "Open Source Dilemma strategy cards".into(), symbol: "OSDCARD".into() }
    }

    /// Enumeration (in mint order).
    pub fn mt_tokens(&self, from_index: Option<U128>, limit: Option<u32>) -> Vec<Token> {
        let from = from_index.map_or(0, |f| f.0.min(u32::MAX as u128) as u32);
        let limit = limit.unwrap_or(MAX_LIMIT).min(MAX_LIMIT);
        (from..self.token_ids.len().min(from.saturating_add(limit)))
            .filter_map(|i| self.token(self.token_ids.get(i).unwrap()))
            .collect()
    }

    pub fn mt_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u32>) -> Vec<Token> {
        let from = from_index.map_or(0, |f| f.0.min(usize::MAX as u128) as usize);
        let limit = limit.unwrap_or(MAX_LIMIT).min(MAX_LIMIT) as usize;
        self.owner_tokens
            .get(&account_id)
            .map(|ids| ids.iter().skip(from).take(limit).filter_map(|t| self.token(t)).collect())
            .unwrap_or_default()
    }

    /// All cards of one agent across seasons, oldest first.
    pub fn cards_for_agent(&self, agent_id: AccountId) -> Vec<Token> {
        self.agent_cards.get(&agent_id).map(|ids| ids.iter().filter_map(|t| self.token(t)).collect()).unwrap_or_default()
    }

    pub fn get_config(&self) -> Config {
        Config { owner: self.owner.clone(), core_contract: self.core_contract.clone(), n_tokens: self.token_ids.len() }
    }
}

// ---------------------------------------------------------------- internals

impl Cards {
    fn mark_sealed(keys_deleted: Vec<String>) -> bool {
        env::storage_write(SEALED_KEY, &env::block_height().to_le_bytes());
        emit_osd("contract_sealed", json!({"keys_deleted": keys_deleted, "block": env::block_height()}));
        true
    }

    fn token(&self, id: &TokenId) -> Option<Token> {
        self.tokens.get(id).map(|t| Token {
            token_id: id.clone(),
            owner_id: t.owner_id.clone(),
            supply: U128(t.supply),
            metadata: t.metadata.clone(),
        })
    }

    fn balance(&self, id: &TokenId, account: &AccountId) -> u128 {
        self.balances.get(&(id.clone(), account.clone())).copied().unwrap_or(0)
    }

    fn add_balance(&mut self, id: &TokenId, account: &AccountId, amount: u128) {
        let key = (id.clone(), account.clone());
        let prev = self.balances.get(&key).copied().unwrap_or(0);
        self.balances.insert(key, prev.checked_add(amount).unwrap_or_else(|| env::panic_str("balance overflow")));
        if prev == 0 {
            self.owner_tokens.entry(account.clone()).or_default().push(id.clone());
        }
    }

    fn sub_balance(&mut self, id: &TokenId, account: &AccountId, amount: u128) {
        let key = (id.clone(), account.clone());
        let prev = self.balances.get(&key).copied().unwrap_or(0);
        require!(prev >= amount, format!("insufficient balance of {id}"));
        if prev == amount {
            self.balances.remove(&key);
            if let Some(list) = self.owner_tokens.get_mut(account) {
                list.retain(|t| t != id);
            }
        } else {
            self.balances.insert(key, prev - amount);
        }
    }

    fn update_card_owner(&mut self, id: &TokenId, new_owner: &AccountId) {
        let t = self.tokens.get_mut(id).unwrap();
        if t.supply == 1 {
            t.owner_id = Some(new_owner.clone());
        }
    }

    fn internal_batch_transfer(
        &mut self,
        sender: &AccountId,
        receiver: &AccountId,
        token_ids: &[TokenId],
        amounts: &[u128],
        memo: Option<String>,
    ) {
        require!(sender != receiver, "sender and receiver must differ");
        require!(!token_ids.is_empty() && token_ids.len() == amounts.len(), "token_ids and amounts must be non-empty and equal length");
        for (id, amt) in token_ids.iter().zip(amounts) {
            require!(*amt > 0, "amount must be positive");
            require!(self.tokens.contains_key(id), format!("unknown token {id}"));
            self.sub_balance(id, sender, *amt);
            self.add_balance(id, receiver, *amt);
            self.update_card_owner(id, receiver);
        }
        let mut ev = json!({"old_owner_id": sender, "new_owner_id": receiver, "token_ids": token_ids, "amounts": amounts_json(amounts)});
        if let Some(m) = memo {
            ev["memo"] = json!(m);
        }
        emit("mt_transfer", json!([ev]));
    }

    fn transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        require!(
            env::prepaid_gas().as_gas() > GAS_FOR_TRANSFER_CALL.as_gas() + GAS_FOR_RESOLVE.as_gas(),
            "more gas is required"
        );
        let sender = env::predecessor_account_id();
        let raw: Vec<u128> = amounts.iter().map(|a| a.0).collect();
        self.internal_batch_transfer(&sender, &receiver_id, &token_ids, &raw, memo);
        let previous_owner_ids = vec![sender.clone(); token_ids.len()];
        ext_mt_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_FOR_TRANSFER_CALL)
            .mt_on_transfer(sender, previous_owner_ids.clone(), token_ids.clone(), amounts.clone(), msg)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE)
                    .with_attached_deposit(NearToken::from_yoctonear(0))
                    .mt_resolve_transfer(previous_owner_ids, receiver_id, token_ids, amounts, None),
            )
            .into()
    }
}

#[cfg(test)]
mod tests;
