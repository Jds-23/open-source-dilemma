//! Mock OutLayer (`request_execution`) for integration tests. Real OutLayer yields and resumes
//! with the WASM stdout; here the configured output is returned directly, which the dilemma
//! contract's callback reads the same way. `"__panic__"` makes the call fail (callback_failed).
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, PanicOnDefault};
use serde_json::Value;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockOutlayer {
    outputs: LookupMap<String, String>,
    calls: LookupMap<String, u32>,
    last_request: Option<String>,
}

#[near]
impl MockOutlayer {
    #[init]
    pub fn new() -> Self {
        Self { outputs: LookupMap::new(b"o"), calls: LookupMap::new(b"c"), last_request: None }
    }

    /// `key` = a play `match_key`, or `"derive_pubkey"`.
    pub fn set_output(&mut self, key: String, output: String) {
        self.outputs.insert(key, output);
    }

    #[payable]
    pub fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Value,
        input_data: String,
        secrets_ref: Value,
        response_format: String,
        payer_account_id: AccountId,
    ) -> Value {
        let input: Value = serde_json::from_str(&input_data).expect("input_data must be JSON");
        let key = match input["action"].as_str() {
            Some("derive_pubkey") => "derive_pubkey".to_string(),
            Some("play_match") => input["match_key"].as_str().expect("match_key").to_string(),
            _ => env::panic_str("unknown action"),
        };
        let n = self.calls.get(&key).copied().unwrap_or(0);
        self.calls.insert(key.clone(), n + 1);
        self.last_request = Some(
            serde_json::json!({
                "predecessor": env::predecessor_account_id(),
                "deposit": env::attached_deposit().as_yoctonear().to_string(),
                "source": source, "resource_limits": resource_limits, "input": input,
                "secrets_ref": secrets_ref, "response_format": response_format,
                "payer_account_id": payer_account_id,
            })
            .to_string(),
        );
        let out = self.outputs.get(&key).cloned().unwrap_or_else(|| env::panic_str("no output configured"));
        if out == "__panic__" {
            env::panic_str("mock outlayer failure");
        }
        serde_json::from_str(&out).expect("configured output must be JSON")
    }

    pub fn get_calls(&self, key: String) -> u32 {
        self.calls.get(&key).copied().unwrap_or(0)
    }

    pub fn get_last_request(&self) -> Option<String> {
        self.last_request.clone()
    }
}
