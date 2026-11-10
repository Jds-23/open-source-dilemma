//! NEAR AI Cloud calls: one chat completion per side, strict C/D parsing, signature fetch.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::http::{Http, HttpError};
use crate::{template, ErrorCode, Move, Params, DEFAULT_BASE_URL, SIG_POLL_ATTEMPTS, SIG_POLL_SLEEP_MS};

pub struct Config<'a> {
    pub base_url: String,
    pub api_key: &'a str,
    pub signing_algo: &'a str,
    pub params: &'a Params,
}

#[derive(Debug, Clone)]
pub struct Decision {
    pub mv: Move,
    /// Reply was not exactly one letter `C`/`D` (logged, never output).
    pub flagged: bool,
    pub chat_id: String,
    pub request_sha256: String,
    pub response_sha256: String,
}

impl Decision {
    pub fn chat_id_out(&self) -> String {
        if is_safe_id(&self.chat_id) {
            self.chat_id.clone()
        } else {
            String::new()
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Signature {
    pub text: String,
    pub sig: String,
}

fn is_safe_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn sha256_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

/// `NEARAI_BASE_URL` if it is an https `*.near.ai` URL (any URL with feature
/// `insecure-base-url`), else the compiled-in default.
pub fn resolve_base_url(env: Option<&str>) -> String {
    let Some(raw) = env.map(str::trim).filter(|s| !s.is_empty()) else {
        return DEFAULT_BASE_URL.to_string();
    };
    let url = raw.trim_end_matches('/');
    if cfg!(feature = "insecure-base-url") {
        return url.to_string();
    }
    let ok = url.strip_prefix("https://").is_some_and(|rest| {
        let host = rest.split('/').next().unwrap_or("");
        (host == "near.ai" || host.ends_with(".near.ai"))
            && host.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'-')
    });
    if ok {
        url.to_string()
    } else {
        eprintln!("referee: NEARAI_BASE_URL rejected, using default");
        DEFAULT_BASE_URL.to_string()
    }
}

/// Exact request bytes (the signed text hashes these, so they must be reproducible).
pub fn request_body(params: &Params, own: &str, opp: &str) -> Vec<u8> {
    json!({
        "model": params.model,
        "messages": [
            { "role": "system", "content": template::system_prompt() },
            { "role": "user", "content": template::user_message(own, opp) }
        ],
        "temperature": 0,
        "seed": params.seed,
        "max_tokens": params.max_tokens,
        "stream": false,
        "chat_template_kwargs": { "enable_thinking": false }
    })
    .to_string()
    .into_bytes()
}

/// Strict parser (INTERFACE.md §8): trim + uppercase, first char `C`/`D` is the move, anything
/// else is `D`. `flagged` unless the reply is exactly one letter (an optional trailing `.` is ok).
/// A leading empty `<think></think>` block (Qwen chat template artefact) is ignored.
pub fn parse_move(content: Option<&str>) -> (Move, bool) {
    let Some(raw) = content else { return (Move::D, true) };
    let mut t = raw.trim();
    if let Some(rest) = t.strip_prefix("<think>") {
        if let Some((inner, after)) = rest.split_once("</think>") {
            if inner.trim().is_empty() {
                t = after.trim();
            }
        }
    }
    let up = t.to_uppercase();
    let mv = match up.chars().next() {
        Some('C') => Move::C,
        Some('D') => Move::D,
        _ => return (Move::D, true),
    };
    let strict = up.len() == 1 || up == "C." || up == "D.";
    (mv, !strict)
}

fn map_send(e: HttpError) -> ErrorCode {
    match e {
        HttpError::Timeout => ErrorCode::LlmTimeout,
        HttpError::Send => ErrorCode::LlmSend,
    }
}

/// One referee call for the player whose strategy is `own`.
pub fn decide(http: &mut dyn Http, cfg: &Config, own: &str, opp: &str) -> Result<Decision, ErrorCode> {
    let body = request_body(cfg.params, own, opp);
    let auth = format!("Bearer {}", cfg.api_key);
    let headers = [
        ("Content-Type", "application/json"),
        ("Accept", "application/json"),
        ("Accept-Encoding", "identity"),
        ("Authorization", auth.as_str()),
    ];
    let r = http.post(&format!("{}/chat/completions", cfg.base_url), &headers, &body).map_err(map_send)?;
    if r.status != 200 {
        return Err(ErrorCode::LlmStatus(r.status));
    }
    let v: Value = serde_json::from_slice(&r.body).map_err(|_| ErrorCode::LlmJson)?;
    let msg = v.get("choices").and_then(|c| c.get(0)).and_then(|c| c.get("message")).ok_or(ErrorCode::LlmJson)?;
    let (mv, flagged) = parse_move(msg.get("content").and_then(Value::as_str));
    Ok(Decision {
        mv,
        flagged,
        chat_id: v.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
        request_sha256: sha256_hex(&body),
        response_sha256: sha256_hex(&r.body),
    })
}

fn url_encode(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}

/// Normalise a signature to 128 lowercase hex chars (ed25519), else `None`.
pub fn normalize_sig(s: &str) -> Option<String> {
    let s = s.trim();
    let s = s.strip_prefix("0x").unwrap_or(s).to_ascii_lowercase();
    (s.len() == 128 && s.bytes().all(|c| c.is_ascii_hexdigit())).then_some(s)
}

/// Fetch NEAR AI's signature for a completion. Never fails the match: '' on any problem.
pub fn signature(http: &mut dyn Http, cfg: &Config, d: &Decision) -> Signature {
    if !is_safe_id(&d.chat_id) {
        return Signature::default();
    }
    let url = format!(
        "{}/signature/{}?model={}&signing_algo={}",
        cfg.base_url,
        d.chat_id,
        url_encode(&cfg.params.model),
        url_encode(cfg.signing_algo)
    );
    let auth = format!("Bearer {}", cfg.api_key);
    let headers = [("Accept", "application/json"), ("Accept-Encoding", "identity"), ("Authorization", auth.as_str())];
    for attempt in 0..SIG_POLL_ATTEMPTS {
        if attempt > 0 {
            http.sleep_ms(SIG_POLL_SLEEP_MS);
        }
        let Ok(r) = http.get(&url, &headers) else { continue };
        if r.status != 200 {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(&r.body) else { continue };
        let (Some(text), Some(sig)) =
            (v.get("text").and_then(Value::as_str), v.get("signature").and_then(Value::as_str))
        else {
            continue;
        };
        let expected = format!("{}:{}:{}", cfg.params.model, d.request_sha256, d.response_sha256);
        if text != expected {
            eprintln!("referee: signed_text differs from local request/response hashes");
        }
        return match normalize_sig(sig) {
            Some(sig) if text.len() <= 200 && text.is_ascii() => Signature { text: text.to_string(), sig },
            _ => Signature::default(),
        };
    }
    Signature::default()
}
