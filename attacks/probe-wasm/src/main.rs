//! Attack-5 probe: a WASM that is NOT the pinned referee, run with the game's `secrets_ref`.
//! If OutLayer's keystore honoured the WasmHash binding, the secret env vars are absent.
//! Prints presence flags and env var NAMES only; never prints a value.
use std::io::Read;

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).ok();
    let has = |k: &str| std::env::var_os(k).map(|v| !v.is_empty()).unwrap_or(false);
    let mut names: Vec<String> = std::env::vars_os().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
    names.sort();
    let pred = std::env::var("NEAR_PREDECESSOR_ID").unwrap_or_default();
    let quoted: Vec<String> = names.iter().map(|n| format!("\"{}\"", n.replace('"', ""))).collect();
    print!(
        "{{\"probe\":\"osd-attack-5\",\"season_seed_present\":{},\"nearai_key_present\":{},\"predecessor\":\"{}\",\"env_names\":[{}]}}",
        has("PROTECTED_SEASON_SEED"),
        has("NEARAI_API_KEY"),
        pred.replace('"', ""),
        quoted.join(",")
    );
}
