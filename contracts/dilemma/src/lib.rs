//! Open Source Dilemma — OutLayer spike contract.
//! One pinned WASM (WasmUrl{url,hash}); results arrive via OutLayer yield/resume
//! as the return value of request_execution, read in #[private] callbacks.
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::LookupMap;
use near_sdk::{env, log, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};
use serde_json::{json, Value};

const OUTLAYER: &str = "outlayer.testnet";
const CALLBACK_GAS: Gas = Gas::from_tgas(30);
const MIN_DEPOSIT: NearToken = NearToken::from_millinear(20);

#[derive(Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
#[near(serializers = [borsh])]
pub struct MatchRecord {
    pub a: AccountId,
    pub b: AccountId,
    /// "pending" | "settled" | "void"
    pub status: String,
    pub a_move: Option<String>,
    pub b_move: Option<String>,
    pub a_payoff: u8,
    pub b_payoff: u8,
    /// on-chain ed25519 check of NEAR AI Cloud provider_tee signatures vs pinned key
    pub sig_a_ok: bool,
    pub sig_b_ok: bool,
    /// raw WASM output (no prompt text)
    pub raw: Option<String>,
    pub requested_at: u64,
    pub settled_at: Option<u64>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Dilemma {
    owner: AccountId,
    wasm_url: String,
    wasm_hash: String,
    secrets_owner: AccountId,
    secrets_profile: String,
    season: String,
    nearai_signer: String,
    pubkey: Option<String>,
    commits: LookupMap<AccountId, String>,
    matches: LookupMap<u64, MatchRecord>,
}

#[near]
impl Dilemma {
    #[init]
    pub fn new(wasm_url: String, wasm_hash: String, secrets_owner: AccountId, secrets_profile: String,
               season: String, nearai_signer: String) -> Self {
        Self { owner: env::predecessor_account_id(), wasm_url, wasm_hash, secrets_owner, secrets_profile,
               season, nearai_signer, pubkey: None,
               commits: LookupMap::new(b"c"), matches: LookupMap::new(b"m") }
    }

    fn outlayer_call(&self, input: Value, max_secs: u64) -> Promise {
        let args = json!({
            "source": {"WasmUrl": {"url": self.wasm_url, "hash": self.wasm_hash, "build_target": "wasm32-wasip2"}},
            "resource_limits": {"max_instructions": 20_000_000_000u64, "max_memory_mb": 128, "max_execution_seconds": max_secs},
            "input_data": input.to_string(),
            "secrets_ref": {"profile": self.secrets_profile, "account_id": self.secrets_owner},
            "response_format": "Json",
            "payer_account_id": env::predecessor_account_id(),
        });
        Promise::new(OUTLAYER.parse().unwrap()).function_call_weight(
            "request_execution".into(), args.to_string().into_bytes(), env::attached_deposit(),
            Gas::from_tgas(0), near_sdk::GasWeight(1))
    }

    /// C. Ask the pinned WASM for the season's secp256k1 pubkey.
    #[payable]
    pub fn init_season(&mut self) -> Promise {
        assert_eq!(env::predecessor_account_id(), self.owner, "owner only");
        assert!(self.pubkey.is_none(), "pubkey already set");
        assert!(env::attached_deposit() >= MIN_DEPOSIT, "attach >= 0.02 NEAR");
        self.outlayer_call(json!({"action": "derive_pubkey", "season": self.season}), 30)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_pubkey())
    }

    #[private]
    pub fn on_pubkey(&mut self, #[callback_result] r: Result<Option<Value>, PromiseError>) -> Option<String> {
        match r {
            Ok(Some(v)) if v["pubkey"].is_string() => {
                let pk = v["pubkey"].as_str().unwrap().to_string();
                assert!(pk.len() == 66, "bad pubkey");
                self.pubkey = Some(pk.clone());
                log!("season pubkey stored: {}", pk);
                Some(pk)
            }
            other => { log!("derive_pubkey failed: {:?}", other.map(|o| o.map(|v| v.to_string()))); None }
        }
    }

    /// D. Store the caller's ECIES ciphertext (hex). One per account; locked once used.
    pub fn commit(&mut self, ciphertext_hex: String) {
        assert!(self.pubkey.is_some(), "season not initialised");
        assert!(ciphertext_hex.len() <= 8192 && hex::decode(&ciphertext_hex).is_ok(), "bad ciphertext");
        self.commits.insert(env::predecessor_account_id(), ciphertext_hex);
    }

    /// D/E. One-shot: a match id can be requested exactly once, whatever the outcome.
    #[payable]
    pub fn play_match(&mut self, match_id: u64, a: AccountId, b: AccountId) -> Promise {
        assert!(self.matches.get(&match_id).is_none(), "match already played");
        assert!(a != b, "same player");
        assert!(env::attached_deposit() >= MIN_DEPOSIT, "attach >= 0.02 NEAR");
        let ca = self.commits.get(&a).expect("a has no commit").clone();
        let cb = self.commits.get(&b).expect("b has no commit").clone();
        self.matches.insert(match_id, MatchRecord {
            a: a.clone(), b: b.clone(), status: "pending".into(), a_move: None, b_move: None,
            a_payoff: 0, b_payoff: 0, sig_a_ok: false, sig_b_ok: false, raw: None,
            requested_at: env::block_height(), settled_at: None });
        let input = json!({"action": "play_match", "season": self.season, "match_id": match_id,
                           "a": {"id": a, "ct": ca}, "b": {"id": b, "ct": cb}});
        self.outlayer_call(input, 120)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_match(match_id))
    }

    #[private]
    pub fn on_match(&mut self, match_id: u64, #[callback_result] r: Result<Option<Value>, PromiseError>) -> String {
        let mut m = self.matches.get(&match_id).expect("no match").clone();
        assert_eq!(m.status, "pending");
        m.settled_at = Some(env::block_height());
        let v = match r { Ok(Some(v)) if v["a"].is_string() && v["b"].is_string() => v, other => {
            // Never retry: failure/timeout voids the match (no re-roll path).
            m.status = "void".into();
            m.raw = other.ok().flatten().map(|v| v.to_string());
            self.matches.insert(match_id, m);
            return "void".into();
        }};
        let (am, bm) = (v["a"].as_str().unwrap().to_string(), v["b"].as_str().unwrap().to_string());
        let (pa, pb) = match (am.as_str(), bm.as_str()) {
            ("C", "C") => (3, 3), ("D", "D") => (1, 1), ("D", "C") => (5, 0), ("C", "D") => (0, 5), _ => (0, 0) };
        m.sig_a_ok = self.check_sig(&v["ta"], &v["sa"]);
        m.sig_b_ok = self.check_sig(&v["tb"], &v["sb"]);
        m.a_move = Some(am); m.b_move = Some(bm); m.a_payoff = pa; m.b_payoff = pb;
        m.status = "settled".into();
        m.raw = Some(v.to_string());
        self.matches.insert(match_id, m);
        format!("settled {}{}", v["a"].as_str().unwrap(), v["b"].as_str().unwrap())
    }

    /// F. Verify NEAR AI Cloud provider_tee ed25519 signature over "<model>:<req_hash>:<resp_hash>".
    fn check_sig(&self, text: &Value, sig: &Value) -> bool {
        let (Some(t), Some(s)) = (text.as_str(), sig.as_str()) else { return false };
        let (Ok(sig), Ok(pk)) = (hex::decode(s), hex::decode(&self.nearai_signer)) else { return false };
        let (Ok(sig), Ok(pk)) = (<[u8; 64]>::try_from(sig), <[u8; 32]>::try_from(pk)) else { return false };
        env::ed25519_verify(&sig, t.as_bytes(), &pk)
    }

    pub fn get_pubkey(&self) -> Option<String> { self.pubkey.clone() }
    pub fn get_commit(&self, account_id: AccountId) -> Option<String> { self.commits.get(&account_id).cloned() }
    pub fn get_match(&self, match_id: u64) -> Option<MatchRecord> { self.matches.get(&match_id).cloned() }
    pub fn get_config(&self) -> Value {
        json!({"wasm_url": self.wasm_url, "wasm_hash": self.wasm_hash, "secrets_owner": self.secrets_owner,
               "profile": self.secrets_profile, "season": self.season, "nearai_signer": self.nearai_signer})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn contract() -> Dilemma {
        testing_env!(VMContextBuilder::new().predecessor_account_id(accounts(0)).build());
        Dilemma::new("https://example/wasm".into(), "00".repeat(32), accounts(0), "season1".into(),
                     "s1".into(), "89154a43a47684742c3d1753252bb6f49f61da9d8c84fc9b1def2df130cb2d93".into())
    }

    #[test]
    #[should_panic(expected = "season not initialised")]
    fn commit_requires_pubkey() {
        let mut c = contract();
        c.commit("abcd".into());
    }

    #[test]
    fn bad_signature_is_flag_false() {
        let c = contract();
        assert!(!c.check_sig(&json!("text"), &json!("11".repeat(64))));
        assert!(!c.check_sig(&Value::Null, &Value::Null));
        // Real NEAR AI provider_tee signature from spike run D (testnet match 1).
        let ta = "Qwen/Qwen3.8-27B:c05141426b7c72ac2afe1ef15e0240c9e3491de72d9c0792157324874d299190:e291f748d402f2d18fee4ca7924b85b443fba3b421041e3ede57fffac9da1a95";
        let sa = "d53a7906d7a7749298dfe91673894ba2c1966eae89d04aac994fe4ced38096e98f17d64d0f70c4866fe679253c356a36fe8a3acda129563d4422cf48bea2c001";
        assert!(c.check_sig(&json!(ta), &json!(sa)));
    }
}
