#![allow(dead_code, clippy::type_complexity)]
//! Shared test helpers: mocked NEAR AI HTTP layer + fixture loading.

use referee::http::{Http, HttpError, HttpResponse};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;

pub const CONTRACT: &str = "osd.baldingsucks7993.testnet";

/// TEST-ONLY season seed, read from the fixture (never hard-coded in this crate).
pub fn test_seed() -> String {
    fixture("test-key-vector.json")["seed_hex"].as_str().unwrap().to_string()
}

pub fn test_pubkey() -> String {
    fixture("test-key-vector.json")["public_key_hex"].as_str().unwrap().to_string()
}

pub fn fixture(name: &str) -> Value {
    let p = format!("{}/../../interfaces/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{p}: {e}"))).unwrap()
}

pub fn env() -> referee::Env {
    referee::Env {
        predecessor: Some(CONTRACT.into()),
        season_seed_hex: Some(test_seed()),
        api_key: Some("test-key".into()),
        base_url: None,
        signing_algo: None,
    }
}

/// What the mock returns for a chat completion.
#[derive(Clone)]
pub enum Chat {
    Reply(&'static str),
    NullContent,
    Status(u16),
    Raw(&'static str),
    Err(HttpError),
}

/// What the mock returns for a signature poll.
#[derive(Clone)]
pub enum Sig {
    /// Correct `<model>:<sha256(req)>:<sha256(resp)>` text with a 128-hex signature.
    Good,
    Custom {
        text: String,
        sig: String,
    },
    Status(u16),
}

#[derive(Default)]
pub struct MockHttp {
    pub chats: VecDeque<Chat>,
    pub sigs: VecDeque<Sig>,
    pub default_sig: Option<Sig>,
    pub posts: Vec<(String, Vec<(String, String)>, Vec<u8>)>,
    pub gets: Vec<String>,
    pub sleeps: u32,
    /// chat id -> (sha256 request, sha256 response)
    hashes: Vec<(String, String, String)>,
    n: u32,
}

impl MockHttp {
    pub fn new(chats: Vec<Chat>) -> Self {
        MockHttp { chats: chats.into(), default_sig: Some(Sig::Good), ..Default::default() }
    }
    pub fn calls(&self) -> usize {
        self.posts.len() + self.gets.len()
    }
    pub fn request_json(&self, i: usize) -> Value {
        serde_json::from_slice(&self.posts[i].2).unwrap()
    }
}

fn h(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

pub fn sig_hex(seed: u32) -> String {
    format!("{:0128x}", seed as u128 * 0x1234567)
}

impl Http for MockHttp {
    fn post(&mut self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Result<HttpResponse, HttpError> {
        self.posts.push((
            url.into(),
            headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            body.to_vec(),
        ));
        self.n += 1;
        let id = format!("chat{:028x}", self.n);
        let resp = match self.chats.pop_front().expect("unexpected chat call") {
            Chat::Err(e) => return Err(e),
            Chat::Status(s) => return Ok(HttpResponse { status: s, body: b"{\"error\":\"x\"}".to_vec() }),
            Chat::Raw(r) => r.as_bytes().to_vec(),
            Chat::NullContent => {
                json!({"id": id, "choices":[{"message":{"role":"assistant","content":null}}]}).to_string().into_bytes()
            }
            Chat::Reply(c) => {
                json!({"id": id, "choices":[{"message":{"role":"assistant","content":c}}]}).to_string().into_bytes()
            }
        };
        let model = serde_json::from_slice::<Value>(body)
            .ok()
            .and_then(|v| v["model"].as_str().map(String::from))
            .unwrap_or_default();
        self.hashes.push((id, h(body), format!("{model}|{}", h(&resp))));
        Ok(HttpResponse { status: 200, body: resp })
    }

    fn get(&mut self, url: &str, _: &[(&str, &str)]) -> Result<HttpResponse, HttpError> {
        self.gets.push(url.into());
        let sig = self.sigs.pop_front().or_else(|| self.default_sig.clone()).expect("unexpected sig call");
        let chat_id = url.split("/signature/").nth(1).unwrap().split('?').next().unwrap().to_string();
        match sig {
            Sig::Status(s) => Ok(HttpResponse { status: s, body: b"{}".to_vec() }),
            Sig::Custom { text, sig } => Ok(HttpResponse {
                status: 200,
                body: json!({"text": text, "signature": sig, "signing_algo": "ed25519"}).to_string().into_bytes(),
            }),
            Sig::Good => {
                let (_, req, mr) = self.hashes.iter().find(|(id, _, _)| *id == chat_id).expect("chat id").clone();
                let (model, resp) = mr.split_once('|').unwrap();
                let n = self.gets.len() as u32;
                Ok(HttpResponse {
                    status: 200,
                    body: json!({"text": format!("{model}:{req}:{resp}"), "signature": sig_hex(n), "signing_algo": "ed25519"})
                        .to_string()
                        .into_bytes(),
                })
            }
        }
    }

    fn sleep_ms(&mut self, _: u64) {
        self.sleeps += 1;
    }
}

/// Input with the compiled-in template hash (fixtures still carry the placeholder hash).
pub fn with_real_template(mut v: Value) -> Value {
    v["referee_template_hash"] = json!(referee::template::hash_hex());
    v
}

pub fn run(v: &Value, http: &mut MockHttp) -> Value {
    run_env(v, &env(), http)
}

pub fn run_env(v: &Value, e: &referee::Env, http: &mut MockHttp) -> Value {
    let s = referee::run(&v.to_string(), e, http);
    serde_json::from_str(&s).unwrap_or_else(|_| panic!("output not JSON: {s}"))
}

pub fn run_raw(v: &Value, http: &mut MockHttp) -> String {
    referee::run(&v.to_string(), &env(), http)
}

fn is_hex(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// Hand-rolled check against `play_match_output` / `error_output` in wasm-io.schema.json.
pub fn assert_schema_output(raw: &str) {
    assert!(raw.len() <= 900, "output {} bytes", raw.len());
    let v: Value = serde_json::from_str(raw).unwrap();
    let o = v.as_object().unwrap();
    let mk_ok = |s: &str| {
        let p: Vec<&str> = s.splitn(3, ':').collect();
        p.len() == 3 && !p[0].is_empty() && p[0].bytes().all(|c| c.is_ascii_digit())
    };
    if let Some(e) = o.get("error") {
        let e = e.as_str().unwrap();
        let known = [
            "bad_input",
            "unknown_action",
            "predecessor_not_allowed",
            "template_mismatch",
            "no_seed",
            "bad_seed",
            "key_derivation",
            "no_api_key",
            "duplicate_prompt",
            "llm_send",
            "llm_timeout",
            "llm_json",
        ];
        let status =
            e.strip_prefix("llm_status_").is_some_and(|d| d.len() == 3 && d.bytes().all(|c| c.is_ascii_digit()));
        assert!(known.contains(&e) || status, "bad error code {e}");
        for k in o.keys() {
            assert!(k == "error" || k == "match_key", "extra key {k}");
        }
        if let Some(mk) = o.get("match_key") {
            assert!(mk_ok(mk.as_str().unwrap()));
        }
        return;
    }
    if let Some(pk) = o.get("pubkey") {
        let pk = pk.as_str().unwrap();
        assert!(o.len() == 1 && (pk.starts_with("02") || pk.starts_with("03")) && is_hex(pk, 66));
        return;
    }
    let keys =
        ["match_key", "a_move", "b_move", "a_chat_id", "b_chat_id", "a_signed_text", "b_signed_text", "a_sig", "b_sig"];
    assert_eq!(o.len(), keys.len(), "{raw}");
    for k in keys {
        assert!(o.get(k).and_then(Value::as_str).is_some(), "missing {k}");
    }
    assert!(mk_ok(o["match_key"].as_str().unwrap()));
    for k in ["a_move", "b_move"] {
        assert!(["C", "D", "F"].contains(&o[k].as_str().unwrap()));
    }
    for k in ["a_chat_id", "b_chat_id"] {
        assert!(o[k].as_str().unwrap().len() <= 64);
    }
    for k in ["a_signed_text", "b_signed_text"] {
        assert!(o[k].as_str().unwrap().len() <= 200);
    }
    for k in ["a_sig", "b_sig"] {
        let s = o[k].as_str().unwrap();
        assert!(s.is_empty() || is_hex(s, 128), "bad sig {s}");
    }
}

pub fn prompts() -> Vec<(String, String, Vec<u8>)> {
    fixture("prompts.json")
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p["agent_id"].as_str().unwrap().to_string(),
                p["prompt"].as_str().unwrap().to_string(),
                hex::decode(p["salt"].as_str().unwrap()).unwrap(),
            )
        })
        .collect()
}

pub fn assert_no_prompt_text(raw: &str) {
    for (_, prompt, _) in prompts() {
        assert!(!raw.contains(&prompt), "output leaks a prompt");
        // also no long fragment of it
        for w in prompt.as_bytes().windows(24) {
            if let Ok(frag) = std::str::from_utf8(w) {
                assert!(!raw.contains(frag), "output leaks prompt fragment");
            }
        }
    }
}

/// Encrypt arbitrary plaintext to the TEST-ONLY season-1 key.
pub fn encrypt(plaintext: &[u8]) -> String {
    let pk = hex::decode(test_pubkey()).unwrap();
    hex::encode(ecies::encrypt(&pk, plaintext).unwrap())
}

pub fn plaintext(salt: &[u8], prompt: &[u8]) -> Vec<u8> {
    let mut v = vec![0x01];
    v.extend_from_slice(salt);
    v.extend_from_slice(prompt);
    v
}

/// A valid play_match input for arbitrary agents/prompts (real template hash).
pub fn make_input(a: &str, pa: &str, b: &str, pb: &str) -> Value {
    let (sa, sb) = ([7u8; 32], [9u8; 32]);
    json!({
        "action": "play_match",
        "season": 1,
        "match_key": format!("1:{a}:{b}"),
        "a": a, "b": b,
        "ct_a": encrypt(&plaintext(&sa, pa.as_bytes())),
        "ct_b": encrypt(&plaintext(&sb, pb.as_bytes())),
        "hash_a": referee::commitment(pa, &sa, a),
        "hash_b": referee::commitment(pb, &sb, b),
        "referee_template_hash": referee::template::hash_hex(),
        "params": {"model":"Qwen/Qwen3.8-27B","temperature":0,"seed":42,"max_tokens":4,"enable_thinking":false,"max_prompt_bytes":4000}
    })
}
