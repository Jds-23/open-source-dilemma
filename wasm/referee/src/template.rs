//! Canonical referee template (`wasm/referee/referee-template.txt`, compiled in byte-exact).
//!
//! File layout: `<system prompt>\n<<<USER>>>\n<user frame>`; the user frame holds the two
//! placeholders `{{YOUR_STRATEGY}}` and `{{OPPONENT_SOURCE}}`, each exactly once.
//! `referee_template_hash` = sha256 of the whole file.

use sha2::{Digest, Sha256};

pub const TEMPLATE: &str = include_str!("../referee-template.txt");
pub const USER_MARKER: &str = "\n<<<USER>>>\n";
pub const PH_OWN: &str = "{{YOUR_STRATEGY}}";
pub const PH_OPP: &str = "{{OPPONENT_SOURCE}}";

pub fn hash_hex() -> String {
    hex::encode(Sha256::digest(TEMPLATE.as_bytes()))
}

fn parts() -> (&'static str, &'static str, &'static str, &'static str) {
    let (system, user) = TEMPLATE.split_once(USER_MARKER).expect("template marker");
    let (pre, rest) = user.split_once(PH_OWN).expect("own placeholder");
    let (mid, post) = rest.split_once(PH_OPP).expect("opponent placeholder");
    (system, pre, mid, post)
}

pub fn system_prompt() -> &'static str {
    parts().0
}

/// Neutralise section tags: angle brackets inside strategies become fullwidth `＜` `＞`, so a
/// strategy cannot close its own section or open a fake one.
pub fn sanitize(s: &str) -> String {
    s.replace('<', "\u{FF1C}").replace('>', "\u{FF1E}")
}

/// User message for the player whose strategy is `own`. Positional, so placeholder text inside a
/// strategy is never substituted.
pub fn user_message(own: &str, opp: &str) -> String {
    let (_, pre, mid, post) = parts();
    let (own, opp) = (sanitize(own), sanitize(opp));
    let mut s = String::with_capacity(pre.len() + own.len() + mid.len() + opp.len() + post.len());
    s.push_str(pre);
    s.push_str(&own);
    s.push_str(mid);
    s.push_str(&opp);
    s.push_str(post);
    s
}
