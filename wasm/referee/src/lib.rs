//! Open Source Dilemma referee: OutLayer WASI P2 job (`interfaces-v2`).
//!
//! I/O contract: `interfaces/wasm-io.schema.json`, rules: `interfaces/INTERFACE.md` §5 and §8.
//! stdin = OutLayer `input_data` (JSON); stdout = one JSON object, never any prompt text.
//! Everything here is pure except the [`http::Http`] trait, so `cargo test` drives it with a mock.

pub mod http;
pub mod llm;
pub mod template;

use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::http::Http;

/// The deployed contract (INTERFACE.md §9: compile-time constant). Override at build time with
/// `OSD_CONTRACT_ID=<account> cargo build ...` (changes the WASM hash).
pub const ALLOWED_PREDECESSOR: &str = match option_env!("OSD_CONTRACT_ID") {
    Some(id) => id,
    None => "osd.baldingsucks7993.testnet",
};
pub const DEFAULT_BASE_URL: &str = "https://cloud-api.near.ai/v1";
pub const DEFAULT_SIGNING_ALGO: &str = "ed25519";
pub const PLAY_OUTPUT_MAX_BYTES: usize = 900;
pub const PROMPT_MAX_BYTES: usize = 4000;
pub const CT_HEX_MAX_CHARS: usize = 8400;
pub const PLAINTEXT_VERSION: u8 = 0x01;
pub const SALT_LEN: usize = 32;
pub const SIG_POLL_ATTEMPTS: u32 = 5;
pub const SIG_POLL_SLEEP_MS: u64 = 700;

/// Process environment as seen by the job (secrets are injected as env vars by OutLayer).
#[derive(Debug, Clone, Default)]
pub struct Env {
    pub predecessor: Option<String>,
    pub season_seed_hex: Option<String>,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub signing_algo: Option<String>,
}

impl Env {
    pub fn from_process() -> Self {
        let get = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        Env {
            predecessor: get("NEAR_PREDECESSOR_ID"),
            season_seed_hex: get("PROTECTED_SEASON_SEED"),
            api_key: get("NEARAI_API_KEY"),
            base_url: get("NEARAI_BASE_URL"),
            signing_algo: get("NEARAI_SIGNING_ALGO"),
        }
    }
}

/// `error_code` from the schema (+ `llm_status_NNN`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorCode {
    BadInput,
    UnknownAction,
    PredecessorNotAllowed,
    TemplateMismatch,
    NoSeed,
    BadSeed,
    KeyDerivation,
    NoApiKey,
    DuplicatePrompt,
    LlmSend,
    LlmTimeout,
    LlmJson,
    LlmStatus(u16),
}

impl ErrorCode {
    pub fn as_string(&self) -> String {
        match self {
            ErrorCode::BadInput => "bad_input".into(),
            ErrorCode::UnknownAction => "unknown_action".into(),
            ErrorCode::PredecessorNotAllowed => "predecessor_not_allowed".into(),
            ErrorCode::TemplateMismatch => "template_mismatch".into(),
            ErrorCode::NoSeed => "no_seed".into(),
            ErrorCode::BadSeed => "bad_seed".into(),
            ErrorCode::KeyDerivation => "key_derivation".into(),
            ErrorCode::NoApiKey => "no_api_key".into(),
            ErrorCode::DuplicatePrompt => "duplicate_prompt".into(),
            ErrorCode::LlmSend => "llm_send".into(),
            ErrorCode::LlmTimeout => "llm_timeout".into(),
            ErrorCode::LlmJson => "llm_json".into(),
            // Schema: ^llm_status_[0-9]{3}$; HTTP status codes are 100..=999.
            ErrorCode::LlmStatus(s) => format!("llm_status_{:03}", (*s).clamp(100, 999)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Move {
    C,
    D,
    F,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PlayOutput {
    pub match_key: String,
    pub a_move: Move,
    pub b_move: Move,
    pub a_chat_id: String,
    pub b_chat_id: String,
    pub a_signed_text: String,
    pub b_signed_text: String,
    pub a_sig: String,
    pub b_sig: String,
}

#[derive(Debug, Clone, Serialize)]
struct ErrorOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    match_key: Option<String>,
    error: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeriveInput {
    #[allow(dead_code)]
    action: String,
    season: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
    pub model: String,
    pub temperature: f64,
    pub seed: i64,
    pub max_tokens: u32,
    pub enable_thinking: bool,
    pub max_prompt_bytes: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PlayInput {
    #[allow(dead_code)]
    action: String,
    season: u32,
    match_key: String,
    a: String,
    b: String,
    ct_a: String,
    ct_b: String,
    hash_a: String,
    hash_b: String,
    referee_template_hash: String,
    params: Params,
}

/// Why a side forfeits (logged to stderr only; the output just says `F`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Forfeit {
    BadHex,
    TooLong,
    Undecryptable,
    ShortPlaintext,
    BadVersion,
    NotUtf8,
    PromptTooLarge,
    CommitmentMismatch,
}

fn sha256_hex(parts: &[&[u8]]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    hex::encode(h.finalize())
}

pub fn commitment(prompt: &str, salt: &[u8], agent_id: &str) -> String {
    sha256_hex(&[prompt.as_bytes(), salt, agent_id.as_bytes()])
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_account(s: &str) -> bool {
    (2..=64).contains(&s.len()) && s.bytes().all(|c| matches!(c, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'))
}

fn is_match_key(s: &str) -> bool {
    let mut it = s.splitn(3, ':');
    let (Some(n), Some(a), Some(b)) = (it.next(), it.next(), it.next()) else { return false };
    let acct =
        |x: &str| !x.is_empty() && x.bytes().all(|c| matches!(c, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'));
    !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()) && acct(a) && acct(b)
}

/// Season secret key per INTERFACE.md §5: HKDF-SHA256(salt none, ikm seed, info "osd:ecies:<id>").
pub fn season_key(seed_hex: Option<&str>, season: u32) -> Result<([u8; 32], [u8; 33]), ErrorCode> {
    let seed_hex = seed_hex.ok_or(ErrorCode::NoSeed)?;
    let seed = hex::decode(seed_hex.trim()).map_err(|_| ErrorCode::BadSeed)?;
    if seed.len() != 32 {
        return Err(ErrorCode::BadSeed);
    }
    let mut sk = [0u8; 32];
    Hkdf::<Sha256>::new(None, &seed)
        .expand(format!("osd:ecies:{season}").as_bytes(), &mut sk)
        .map_err(|_| ErrorCode::KeyDerivation)?;
    let secret = libsecp256k1::SecretKey::parse(&sk).map_err(|_| ErrorCode::KeyDerivation)?;
    let pk = libsecp256k1::PublicKey::from_secret_key(&secret).serialize_compressed();
    Ok((sk, pk))
}

/// Decrypt one side and verify its salted commitment. `Ok(prompt)` or the forfeit reason.
pub fn open_entry(
    sk: &[u8; 32],
    ct_hex: &str,
    agent_id: &str,
    expected: &str,
    max_prompt_bytes: i64,
) -> Result<String, Forfeit> {
    if ct_hex.len() > CT_HEX_MAX_CHARS {
        return Err(Forfeit::TooLong);
    }
    if ct_hex.bytes().any(|c| c.is_ascii_uppercase()) {
        return Err(Forfeit::BadHex);
    }
    let ct = hex::decode(ct_hex).map_err(|_| Forfeit::BadHex)?;
    let pt = ecies::decrypt(sk, &ct).map_err(|_| Forfeit::Undecryptable)?;
    if pt.len() < 1 + SALT_LEN {
        return Err(Forfeit::ShortPlaintext);
    }
    if pt[0] != PLAINTEXT_VERSION {
        return Err(Forfeit::BadVersion);
    }
    let salt = &pt[1..1 + SALT_LEN];
    let prompt = std::str::from_utf8(&pt[1 + SALT_LEN..]).map_err(|_| Forfeit::NotUtf8)?;
    let cap = max_prompt_bytes.clamp(0, PROMPT_MAX_BYTES as i64) as usize;
    if prompt.len() > cap {
        return Err(Forfeit::PromptTooLarge);
    }
    if commitment(prompt, salt, agent_id) != expected {
        return Err(Forfeit::CommitmentMismatch);
    }
    Ok(prompt.to_string())
}

fn log(msg: &str) {
    // stderr only, never prompt text (only fixed tags and account ids).
    eprintln!("referee: {msg}");
}

fn err_json(match_key: Option<&str>, e: &ErrorCode) -> String {
    let mk = match_key.filter(|m| is_match_key(m)).map(str::to_string);
    serde_json::to_string(&ErrorOutput { match_key: mk, error: e.as_string() }).expect("serialize")
}

/// Entry point: input JSON string → output JSON string (always a single object).
pub fn run(input: &str, env: &Env, http: &mut dyn Http) -> String {
    let v: Value = match serde_json::from_str(input) {
        Ok(v @ Value::Object(_)) => v,
        _ => return err_json(None, &ErrorCode::BadInput),
    };
    let match_key = v.get("match_key").and_then(Value::as_str).map(str::to_string);
    let mk = match_key.as_deref();
    if env.predecessor.as_deref() != Some(ALLOWED_PREDECESSOR) {
        return err_json(mk, &ErrorCode::PredecessorNotAllowed);
    }
    match v.get("action").and_then(Value::as_str) {
        Some("derive_pubkey") => match serde_json::from_value::<DeriveInput>(v) {
            Ok(i) if i.season >= 1 => match season_key(env.season_seed_hex.as_deref(), i.season) {
                Ok((_, pk)) => serde_json::json!({ "pubkey": hex::encode(pk) }).to_string(),
                Err(e) => err_json(None, &e),
            },
            _ => err_json(None, &ErrorCode::BadInput),
        },
        Some("play_match") => match serde_json::from_value::<PlayInput>(v) {
            Ok(i) => match play(&i, env, http) {
                Ok(out) => out,
                Err(e) => err_json(Some(&i.match_key), &e),
            },
            Err(_) => err_json(mk, &ErrorCode::BadInput),
        },
        Some(_) => err_json(mk, &ErrorCode::UnknownAction),
        None => err_json(mk, &ErrorCode::BadInput),
    }
}

fn validate(i: &PlayInput) -> Result<(), ErrorCode> {
    let p = &i.params;
    let ok = i.season >= 1
        && is_account(&i.a)
        && is_account(&i.b)
        && i.a.as_bytes() < i.b.as_bytes()
        && i.match_key == format!("{}:{}:{}", i.season, i.a, i.b)
        && is_hex64(&i.hash_a)
        && is_hex64(&i.hash_b)
        && is_hex64(&i.referee_template_hash)
        && !p.model.is_empty()
        && p.model.len() <= 64
        && p.temperature == 0.0
        && (1..=16).contains(&p.max_tokens)
        && !p.enable_thinking
        && p.max_prompt_bytes <= PROMPT_MAX_BYTES as i64;
    if ok {
        Ok(())
    } else {
        Err(ErrorCode::BadInput)
    }
}

fn play(i: &PlayInput, env: &Env, http: &mut dyn Http) -> Result<String, ErrorCode> {
    validate(i)?;
    if i.referee_template_hash != template::hash_hex() {
        return Err(ErrorCode::TemplateMismatch);
    }
    let (sk, _) = season_key(env.season_seed_hex.as_deref(), i.season)?;
    let side_a = open_entry(&sk, &i.ct_a, &i.a, &i.hash_a, i.params.max_prompt_bytes);
    let side_b = open_entry(&sk, &i.ct_b, &i.b, &i.hash_b, i.params.max_prompt_bytes);

    let (pa, pb) = match (side_a, side_b) {
        (Ok(pa), Ok(pb)) => (pa, pb),
        (ra, rb) => {
            // Any F: no LLM calls; the valid side's move is irrelevant to the payoff (C/D vs F pays the same).
            if let Err(f) = &ra {
                log(&format!("forfeit a={} reason={f:?}", i.a));
            }
            if let Err(f) = &rb {
                log(&format!("forfeit b={} reason={f:?}", i.b));
            }
            let mv = |r: &Result<String, Forfeit>| if r.is_err() { Move::F } else { Move::C };
            let out = PlayOutput {
                match_key: i.match_key.clone(),
                a_move: mv(&ra),
                b_move: mv(&rb),
                a_chat_id: String::new(),
                b_chat_id: String::new(),
                a_signed_text: String::new(),
                b_signed_text: String::new(),
                a_sig: String::new(),
                b_sig: String::new(),
            };
            return Ok(fit_output(out));
        }
    };
    if pa.as_bytes() == pb.as_bytes() {
        return Err(ErrorCode::DuplicatePrompt);
    }
    let api_key = env.api_key.as_deref().ok_or(ErrorCode::NoApiKey)?;
    let cfg = llm::Config {
        base_url: llm::resolve_base_url(env.base_url.as_deref()),
        api_key,
        signing_algo: env.signing_algo.as_deref().unwrap_or(DEFAULT_SIGNING_ALGO),
        params: &i.params,
    };
    let ra = llm::decide(http, &cfg, &pa, &pb)?;
    let rb = llm::decide(http, &cfg, &pb, &pa)?;
    drop((pa, pb));
    if ra.flagged {
        log(&format!("nonstrict_reply side=a account={}", i.a));
    }
    if rb.flagged {
        log(&format!("nonstrict_reply side=b account={}", i.b));
    }
    let sa = llm::signature(http, &cfg, &ra);
    let sb = llm::signature(http, &cfg, &rb);
    let out = PlayOutput {
        match_key: i.match_key.clone(),
        a_move: ra.mv,
        b_move: rb.mv,
        a_chat_id: ra.chat_id_out(),
        b_chat_id: rb.chat_id_out(),
        a_signed_text: sa.text,
        b_signed_text: sb.text,
        a_sig: sa.sig,
        b_sig: sb.sig,
    };
    Ok(fit_output(out))
}

/// Serialize; if over the 900-byte limit, drop proof fields (flag-only on chain) until it fits.
pub fn fit_output(mut out: PlayOutput) -> String {
    let ser = |o: &PlayOutput| serde_json::to_string(o).expect("serialize");
    let mut s = ser(&out);
    let steps: [fn(&mut PlayOutput); 4] = [
        |o| {
            o.b_signed_text.clear();
            o.b_sig.clear();
        },
        |o| {
            o.a_signed_text.clear();
            o.a_sig.clear();
        },
        |o| o.b_chat_id.clear(),
        |o| o.a_chat_id.clear(),
    ];
    for step in steps {
        if s.len() <= PLAY_OUTPUT_MAX_BYTES {
            break;
        }
        log("output over 900 bytes, dropping proof fields");
        step(&mut out);
        s = ser(&out);
    }
    s
}
