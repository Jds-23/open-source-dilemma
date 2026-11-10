//! OutLayer WASI P2 entry point: stdin `input_data` JSON → stdout result JSON.
//! Secrets (env): PROTECTED_SEASON_SEED, NEARAI_API_KEY. Optional: NEARAI_BASE_URL,
//! NEARAI_SIGNING_ALGO. OutLayer sets NEAR_PREDECESSOR_ID.

use std::io::{self, Read, Write};

fn main() {
    let mut input = String::new();
    let _ = io::stdin().read_to_string(&mut input);
    let env = referee::Env::from_process();
    #[cfg(target_os = "wasi")]
    let mut http = referee::http::WasiHttp;
    #[cfg(not(target_os = "wasi"))]
    let mut http = referee::http::NoHttp;
    let out = referee::run(&input, &env, &mut http);
    let mut stdout = io::stdout();
    let _ = stdout.write_all(out.as_bytes());
    let _ = stdout.flush();
}
