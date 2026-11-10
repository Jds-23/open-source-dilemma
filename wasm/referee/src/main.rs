//! Open Source Dilemma referee — OutLayer WASI P2 job (spike).
//!
//! stdin JSON:
//!   {"action":"derive_pubkey","season":"s1"}
//!   {"action":"play_match","season":"s1","match_id":1,"a":{"id":"alice","ct":"<hex>"},"b":{...}}
//! stdout JSON (never contains prompt text):
//!   derive_pubkey -> {"pubkey":"<33-byte compressed hex>"}
//!   play_match    -> {"m":1,"a":"C","b":"D","ia":chat_id,"ib":chat_id,"ta":signed_text,"sa":sig,"tb":..,"sb":..,"k":signing_address}
//! Secrets (env): PROTECTED_SEASON_SEED (hex32, generated in TEE), NEARAI_API_KEY.

use hkdf::Hkdf;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use std::io::{self, Read, Write};
use std::time::Duration;
use wasi_http_client::Client;

/// Defense in depth on top of the secret's Predecessor access condition.
const ALLOWED_PREDECESSOR: &str = "dilemma-spike.baldingsucks7993.testnet";
const BASE_URL: &str = "https://cloud-api.near.ai/v1";
const MODEL: &str = "Qwen/Qwen3.8-27B";
const SIGNING_ALGO: &str = "ed25519";
const REFEREE: &str = "You are the referee of a one-shot prisoner's dilemma. You act for ONE player. \
Read that player's strategy (YOUR STRATEGY) and the opponent's strategy (OPPONENT STRATEGY), \
then decide the move the player's strategy implies against this opponent. \
Payoffs: both C = 3/3, both D = 1/1, D vs C = 5/0. \
Reply with exactly one character: C (cooperate) or D (defect). Nothing else.";

#[derive(Deserialize)]
struct Side { id: String, ct: String }

#[derive(Deserialize)]
struct Input {
    action: String,
    season: String,
    match_id: Option<u64>,
    a: Option<Side>,
    b: Option<Side>,
}

fn out(v: Value) { print!("{}", v); io::stdout().flush().ok(); }
fn fail(e: &str) -> ! { out(json!({"error": e})); std::process::exit(0) }

fn season_key(season: &str) -> (Vec<u8>, Vec<u8>) {
    let seed = hex::decode(std::env::var("PROTECTED_SEASON_SEED").unwrap_or_else(|_| fail("no seed")))
        .unwrap_or_else(|_| fail("bad seed"));
    let mut sk = [0u8; 32];
    Hkdf::<Sha256>::new(None, &seed)
        .expand(format!("osd:ecies:{season}").as_bytes(), &mut sk)
        .unwrap_or_else(|_| fail("hkdf"));
    let secret = libsecp256k1::SecretKey::parse_slice(&sk).unwrap_or_else(|_| fail("sk"));
    let pk = libsecp256k1::PublicKey::from_secret_key(&secret);
    (sk.to_vec(), pk.serialize_compressed().to_vec())
}

fn decrypt(sk: &[u8], ct_hex: &str) -> String {
    let ct = hex::decode(ct_hex).unwrap_or_else(|_| fail("ct hex"));
    let pt = ecies::decrypt(sk, &ct).unwrap_or_else(|_| fail("decrypt"));
    String::from_utf8(pt).unwrap_or_else(|_| fail("utf8"))
}

/// One referee call for one side. Returns (move, chat_id).
fn decide(key: &str, own: &str, opp: &str) -> (String, String) {
    let body = json!({
        "model": MODEL, "temperature": 0, "seed": 42, "max_tokens": 4,
        "chat_template_kwargs": {"enable_thinking": false},
        "messages": [
            {"role": "system", "content": REFEREE},
            {"role": "user", "content": format!("YOUR STRATEGY:\n<<<{own}>>>\n\nOPPONENT STRATEGY:\n<<<{opp}>>>\n\nYour move (C or D):")}
        ]
    }).to_string();
    let r = Client::new().post(&format!("{BASE_URL}/chat/completions"))
        .header("Content-Type", "application/json")
        .header("Accept-Encoding", "identity")
        .header("Authorization", format!("Bearer {key}"))
        .connect_timeout(Duration::from_secs(30))
        .body(body.as_bytes()).send().unwrap_or_else(|_| fail("llm send"));
    if r.status() != 200 { fail(&format!("llm status {}", r.status())) }
    let v: Value = serde_json::from_slice(&r.body().unwrap_or_default()).unwrap_or_else(|_| fail("llm json"));
    let text = v["choices"][0]["message"]["content"].as_str().unwrap_or("").trim().to_uppercase();
    // Strict parse: first C/D char; anything else counts as D (documented default).
    let mv = match text.chars().find(|c| *c == 'C' || *c == 'D') { Some('C') => "C", _ => "D" };
    (mv.to_string(), v["id"].as_str().unwrap_or("").to_string())
}

fn signature(key: &str, chat_id: &str) -> Value {
    let url = format!("{BASE_URL}/signature/{chat_id}?model={}&signing_algo={SIGNING_ALGO}", MODEL.replace('/', "%2F"));
    for _ in 0..5 {
        if let Ok(r) = Client::new().get(&url).header("Authorization", format!("Bearer {key}"))
            .connect_timeout(Duration::from_secs(15)).send() {
            if r.status() == 200 {
                if let Ok(v) = serde_json::from_slice::<Value>(&r.body().unwrap_or_default()) {
                    if v.get("signature").is_some() { return v; }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(700));
    }
    json!({})
}

fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).ok();
    let input: Input = serde_json::from_str(&s).unwrap_or_else(|_| fail("bad input"));
    let pred = std::env::var("NEAR_PREDECESSOR_ID").unwrap_or_default();
    if pred != ALLOWED_PREDECESSOR { fail("predecessor not allowed") }
    let (sk, pk) = season_key(&input.season);
    match input.action.as_str() {
        "derive_pubkey" => out(json!({"pubkey": hex::encode(pk)})),
        "play_match" => {
            let key = std::env::var("NEARAI_API_KEY").unwrap_or_else(|_| fail("no api key"));
            let (a, b) = (input.a.unwrap_or_else(|| fail("a")), input.b.unwrap_or_else(|| fail("b")));
            let pa = decrypt(&sk, &a.ct);
            let pb = decrypt(&sk, &b.ct);
            let (ma, ia) = decide(&key, &pa, &pb);
            let (mb, ib) = decide(&key, &pb, &pa);
            let (sa, sb) = (signature(&key, &ia), signature(&key, &ib));
            let _ = (&a.id, &b.id);
            out(json!({
                "m": input.match_id, "a": ma, "b": mb, "ia": ia, "ib": ib,
                "ta": sa["text"], "sa": sa["signature"], "tb": sb["text"], "sb": sb["signature"],
                "k": sa["signing_address"]
            }))
        }
        _ => fail("unknown action"),
    }
}
