//! Pure game logic (no chain access): payoff matrix, circle-method schedule,
//! ranking, validation helpers, commitment hashing. Unit-tested in isolation.
use near_sdk::near;

/// A side's move. `F` = forfeit (entry invalid; INTERFACE.md §1, §5).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Move {
    C,
    D,
    F,
}

impl Move {
    pub fn parse(s: &str) -> Option<Move> {
        match s {
            "C" => Some(Move::C),
            "D" => Some(Move::D),
            "F" => Some(Move::F),
            _ => None,
        }
    }
    pub fn as_char(self) -> char {
        match self {
            Move::C => 'C',
            Move::D => 'D',
            Move::F => 'F',
        }
    }
}

/// INTERFACE.md §2: `(a_units, b_units, pool_units)`; every row sums to 6 (both stakes).
pub fn payoff(a: Move, b: Move) -> (u8, u8, u8) {
    use Move::*;
    match (a, b) {
        (C, C) => (3, 3, 0),
        (D, C) => (5, 1, 0),
        (C, D) => (1, 5, 0),
        (D, D) => (1, 1, 4),
        (F, F) => (0, 0, 6),
        (F, _) => (0, 3, 3),
        (_, F) => (3, 0, 3),
    }
}

/// Number of rounds for `n` entries (circle method): even → n−1, odd → n (one bye per round).
pub fn total_rounds(n: u32) -> u32 {
    if n < 2 {
        0
    } else if n % 2 == 0 {
        n - 1
    } else {
        n
    }
}

/// Pairs of entry indices (commit order) for `round` of the circle method.
/// Position 0 is fixed; positions 1..m rotate right by `round`. For odd `n` index `n` is the bye.
/// Pair order within a round is `(arr[i], arr[m-1-i])` for `i` in `0..m/2` (matches fixtures).
pub fn round_pairs(n: u32, round: u32) -> Vec<(u32, u32)> {
    if n < 2 {
        return vec![];
    }
    let m = if n % 2 == 0 { n } else { n + 1 };
    let k = m - 1;
    let mut arr = Vec::with_capacity(m as usize);
    arr.push(0u32);
    for pos in 1..m {
        // arr[pos] = 1 + ((pos - 1 - round) mod k)
        let v = ((pos - 1) % k + k - (round % k)) % k;
        arr.push(1 + v);
    }
    let mut out = Vec::new();
    for i in 0..(m / 2) {
        let (x, y) = (arr[i as usize], arr[(m - 1 - i) as usize]);
        if x < n && y < n {
            out.push((x, y));
        }
    }
    out
}

/// How many matches entry `idx` has in rounds `0..rounds` (bye rounds excluded).
pub fn matches_in_rounds(n: u32, idx: u32, rounds: u32) -> u32 {
    (0..rounds)
        .filter(|r| round_pairs(n, *r).iter().any(|(x, y)| *x == idx || *y == idx))
        .count() as u32
}

/// Ranking input per entry, in commit order.
#[derive(Clone, Debug)]
pub struct RankInput {
    pub matches_counted: u32,
    pub total_payoff_counted: u64,
}

/// `floor(1000 × Σpayoff / |counted|)`, 0 when nothing counted.
pub fn avg_milli(total: u64, counted: u32) -> u64 {
    if counted == 0 {
        0
    } else {
        total * 1000 / counted as u64
    }
}

/// INTERFACE.md §7: returns `(commit_index, rank)` in leaderboard order. Ranked rows first
/// (avg desc, total desc, commit order asc), then unranked rows (`matches_counted == 0`) in commit order.
pub fn rank(rows: &[RankInput]) -> Vec<(usize, Option<u32>)> {
    let mut ranked: Vec<usize> = (0..rows.len()).filter(|i| rows[*i].matches_counted > 0).collect();
    ranked.sort_by(|x, y| {
        let (rx, ry) = (&rows[*x], &rows[*y]);
        avg_milli(ry.total_payoff_counted, ry.matches_counted)
            .cmp(&avg_milli(rx.total_payoff_counted, rx.matches_counted))
            .then(ry.total_payoff_counted.cmp(&rx.total_payoff_counted))
            .then(x.cmp(y))
    });
    let mut out: Vec<(usize, Option<u32>)> =
        ranked.iter().enumerate().map(|(r, i)| (*i, Some(r as u32 + 1))).collect();
    out.extend((0..rows.len()).filter(|i| rows[*i].matches_counted == 0).map(|i| (i, None)));
    out
}

/// Prize for 1-based `rank`: `floor(pool × bps[rank−1] / 10000)`, 0 past the split.
pub fn prize(pool: u128, split: &[u16], rank: Option<u32>) -> u128 {
    match rank {
        Some(r) if (r as usize) <= split.len() => pool * split[r as usize - 1] as u128 / 10_000,
        _ => 0,
    }
}

pub fn is_lower_hex(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn is_hex64(s: &str) -> bool {
    s.len() == 64 && is_lower_hex(s)
}

/// `^[a-z0-9_-]{2,16}$`
pub fn valid_agent_name(s: &str) -> bool {
    (2..=16).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// `^[a-z0-9_]{1,32}$`
pub fn valid_family(s: &str) -> bool {
    (1..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// `^0[23][0-9a-f]{64}$`
pub fn valid_pubkey(s: &str) -> bool {
    s.len() == 66 && (s.starts_with("02") || s.starts_with("03")) && is_lower_hex(s)
}

/// WASM `error_code` (wasm-io.schema.json): fixed list or `llm_status_<3 digits>`.
pub fn valid_error_code(s: &str) -> bool {
    const CODES: [&str; 12] = [
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
    if CODES.contains(&s) {
        return true;
    }
    match s.strip_prefix("llm_status_") {
        Some(d) => d.len() == 3 && d.bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

/// Bytes hashed for the commitment: `utf8(prompt) || salt[32] || utf8(agent_id)` (INTERFACE.md §5).
pub fn commitment_preimage(prompt: &str, salt: &[u8], agent_id: &str) -> Vec<u8> {
    let mut v = Vec::with_capacity(prompt.len() + salt.len() + agent_id.len());
    v.extend_from_slice(prompt.as_bytes());
    v.extend_from_slice(salt);
    v.extend_from_slice(agent_id.as_bytes());
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn payoff_matrix_matches_interface() {
        use Move::*;
        assert_eq!(payoff(C, C), (3, 3, 0));
        assert_eq!(payoff(D, C), (5, 1, 0));
        assert_eq!(payoff(C, D), (1, 5, 0));
        assert_eq!(payoff(D, D), (1, 1, 4));
        assert_eq!(payoff(F, C), (0, 3, 3));
        assert_eq!(payoff(F, D), (0, 3, 3));
        assert_eq!(payoff(C, F), (3, 0, 3));
        assert_eq!(payoff(D, F), (3, 0, 3));
        assert_eq!(payoff(F, F), (0, 0, 6));
        for a in [C, D, F] {
            for b in [C, D, F] {
                let (x, y, p) = payoff(a, b);
                assert_eq!(x + y + p, 6, "{a:?}/{b:?} must sum to both stakes");
            }
        }
    }

    #[test]
    fn round_robin_covers_every_pair_once() {
        for n in 2..=40u32 {
            let mut seen = BTreeSet::new();
            for r in 0..total_rounds(n) {
                let pairs = round_pairs(n, r);
                let mut in_round = BTreeSet::new();
                for (x, y) in pairs {
                    assert!(x != y && x < n && y < n);
                    assert!(in_round.insert(x) && in_round.insert(y), "agent twice in a round");
                    assert!(seen.insert((x.min(y), x.max(y))), "pair replayed n={n}");
                }
            }
            assert_eq!(seen.len() as u32, n * (n - 1) / 2, "n={n}");
            for i in 0..n {
                assert_eq!(matches_in_rounds(n, i, total_rounds(n)), n - 1);
            }
        }
        assert_eq!(total_rounds(6), 5);
        assert_eq!(total_rounds(7), 7);
        assert_eq!((0..total_rounds(30)).map(|r| round_pairs(30, r).len()).sum::<usize>(), 435);
    }

    #[test]
    fn schedule_matches_fixture_order() {
        // fixtures/matches.json: entries [tft, fairbot, alwaysd, alwaysc, injector, grim]
        assert_eq!(round_pairs(6, 0), vec![(0, 5), (1, 4), (2, 3)]);
        assert_eq!(round_pairs(6, 1), vec![(0, 4), (5, 3), (1, 2)]);
        assert_eq!(round_pairs(6, 2), vec![(0, 3), (4, 2), (5, 1)]);
    }

    #[test]
    fn ranking_order_and_unranked() {
        let rows = vec![
            RankInput { matches_counted: 4, total_payoff_counted: 8 },  // 2000
            RankInput { matches_counted: 4, total_payoff_counted: 10 }, // 2500
            RankInput { matches_counted: 0, total_payoff_counted: 0 },  // unranked
            RankInput { matches_counted: 5, total_payoff_counted: 10 }, // 2000, higher total
            RankInput { matches_counted: 4, total_payoff_counted: 8 },  // tie with 0 → commit order
        ];
        assert_eq!(rank(&rows), vec![(1, Some(1)), (3, Some(2)), (0, Some(3)), (4, Some(4)), (2, None)]);
        assert_eq!(avg_milli(11, 5), 2200);
        assert_eq!(avg_milli(10, 3), 3333);
        assert_eq!(prize(1000, &[5000, 3000, 2000], Some(2)), 300);
        assert_eq!(prize(1000, &[5000, 3000, 2000], Some(4)), 0);
        assert_eq!(prize(1000, &[5000, 3000, 2000], None), 0);
    }

    #[test]
    fn validators() {
        assert!(valid_agent_name("tft") && valid_agent_name("a_b-9"));
        assert!(!valid_agent_name("a") && !valid_agent_name("Abc") && !valid_agent_name("a.b"));
        assert!(!valid_agent_name("abcdefghijklmnopq"));
        assert!(valid_family("tit_for_tat") && !valid_family("") && !valid_family("a-b"));
        assert!(valid_error_code("duplicate_prompt") && valid_error_code("llm_status_503"));
        assert!(!valid_error_code("llm_status_5") && !valid_error_code("boom"));
        assert!(valid_pubkey("0360e153bf8c4758cda4f312a2cc3da490d6593ee843475888337ee944b3ec8cf4"));
        assert!(!valid_pubkey("0460e153bf8c4758cda4f312a2cc3da490d6593ee843475888337ee944b3ec8cf4"));
        assert!(is_hex64(&"ab".repeat(32)) && !is_hex64(&"AB".repeat(32)));
    }
}
