//! Unit tests (mocked blockchain). The season-1 fixture set in `interfaces/fixtures/` is
//! replayed end to end and the contract's views are compared with the fixture files.
use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, RuntimeFeesConfig};
use serde_json::Value;

const CONTRACT: &str = "osd.baldingsucks7993.testnet";
const OWNER: &str = "baldingsucks7993.testnet";
const KEEPER: &str = "keeper.testnet";

fn fx(name: &str) -> Value {
    let s = match name {
        "season" => include_str!("../../../interfaces/fixtures/season.json"),
        "agents" => include_str!("../../../interfaces/fixtures/agents.json"),
        "entries" => include_str!("../../../interfaces/fixtures/entries.json"),
        "matches" => include_str!("../../../interfaces/fixtures/matches.json"),
        "outputs" => include_str!("../../../interfaces/fixtures/wasm-outputs.json"),
        "inputs" => include_str!("../../../interfaces/fixtures/wasm-inputs.json"),
        "leaderboard" => include_str!("../../../interfaces/fixtures/leaderboard.json"),
        "lineage" => include_str!("../../../interfaces/fixtures/lineage.json"),
        "prompts" => include_str!("../../../interfaces/fixtures/prompts.json"),
        "signer" => include_str!("../../../interfaces/fixtures/test-nearai-signer.json"),
        "dup" => include_str!("../../../interfaces/fixtures/wasm-duplicate-example.json"),
        _ => unreachable!(),
    };
    serde_json::from_str(s).unwrap()
}

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

/// Mutable mocked-chain clock + caller.
struct Chain {
    ts: u64,
    height: u64,
}

impl Chain {
    fn set(&self, pred: &str, deposit: NearToken, results: Vec<PromiseResult>) {
        let ctx = VMContextBuilder::new()
            .current_account_id(acc(CONTRACT))
            .predecessor_account_id(acc(pred))
            .signer_account_id(acc(pred))
            .attached_deposit(deposit)
            .block_timestamp(self.ts)
            .block_height(self.height)
            .account_balance(NearToken::from_near(1000))
            .build();
        testing_env!(ctx, near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
    }
    fn call(&self, pred: &str) {
        self.set(pred, NearToken::from_yoctonear(0), vec![]);
    }
    fn pay(&self, pred: &str, d: NearToken) {
        self.set(pred, d, vec![]);
    }
    fn callback(&self, result: Option<&str>) {
        let r = match result {
            Some(s) => PromiseResult::Successful(s.as_bytes().to_vec()),
            None => PromiseResult::Failed,
        };
        self.set(CONTRACT, NearToken::from_yoctonear(0), vec![r]);
    }
}

fn signer_hex() -> String {
    fx("signer")["public_key_hex"].as_str().unwrap().to_string()
}

fn new_contract(chain: &Chain) -> Dilemma {
    chain.call(OWNER);
    Dilemma::new(
        "https://example/referee.wasm".into(),
        "ab".repeat(32),
        acc(OWNER),
        "osd-s1".into(),
        signer_hex(),
        acc("outlayer.testnet"),
    )
}

fn params_from_fixture() -> SeasonParams {
    serde_json::from_value(fx("season")["params"].clone()).unwrap()
}

fn register(c: &mut Dilemma, chain: &Chain, name: &str, owner: &str, budget_near: u128) -> AccountId {
    let id = acc(&format!("{name}.{CONTRACT}"));
    chain.pay(owner, NearToken::from_near(budget_near));
    let _ = c.register_agent(name.into(), "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap());
    chain.callback(Some("null"));
    let r = c.on_agent_created(id.clone(), acc(owner), name.into(), U128(NearToken::from_near(budget_near).as_yoctonear()));
    assert_eq!(r, Some(id.clone()));
    id
}

fn open(c: &mut Dilemma, chain: &mut Chain, p: SeasonParams) -> u32 {
    chain.pay(OWNER, MIN_OUTLAYER_DEPOSIT);
    let sid = c.open_season(p);
    chain.callback(Some(&json!({"pubkey": fx("season")["pubkey"]}).to_string()));
    assert!(c.on_pubkey(sid).is_some());
    sid
}

fn out_for(match_key: &str, a: &str, b: &str) -> String {
    json!({"match_key": match_key, "a_move": a, "b_move": b, "a_chat_id": "x", "b_chat_id": "y",
           "a_signed_text": "", "b_signed_text": "", "a_sig": "", "b_sig": ""})
    .to_string()
}

/// Plays a scheduled match and feeds `result` to `on_match`. Returns the callback string.
fn play(c: &mut Dilemma, chain: &mut Chain, sid: u32, a: &AccountId, b: &AccountId, result: Option<&str>) -> String {
    chain.pay(KEEPER, MIN_OUTLAYER_DEPOSIT);
    let _ = c.play_match(sid, a.clone(), b.clone());
    chain.height += 18;
    chain.callback(result);
    let (a, b) = ordered(a.clone(), b.clone());
    c.on_match(sid, a, b)
}

fn event_names() -> Vec<String> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<Value>(j).unwrap()["event"].as_str().unwrap().to_string())
        .collect()
}

/// Small season with agents/owners `[(name, owner)]`, closed and fully scheduled.
fn small_season(agents: &[(&str, &str)]) -> (Dilemma, Chain, u32, Vec<AccountId>) {
    let mut chain = Chain { ts: 1_000, height: 100 };
    let mut c = new_contract(&chain);
    let ids: Vec<AccountId> = agents.iter().map(|(n, o)| register(&mut c, &chain, n, o, 2)).collect();
    let mut p = params_from_fixture();
    p.commit_deadline_ns = U64(10_000);
    p.play_deadline_ns = U64(20_000);
    p.max_agents = 4;
    let sid = open(&mut c, &mut chain, p);
    for id in &ids {
        chain.call(id.as_str());
        c.commit(sid, id.clone(), "04ab".into(), "cd".repeat(32), "fam".into(), None);
    }
    chain.ts = 10_001;
    chain.call(KEEPER);
    c.close_commits(sid);
    let rounds = c.get_season(sid).unwrap().total_rounds;
    for _ in 0..rounds {
        c.schedule_round(sid);
    }
    (c, chain, sid, ids)
}

fn mkey(sid: u32, a: &AccountId, b: &AccountId) -> String {
    let (a, b) = ordered(a.clone(), b.clone());
    match_key_str(sid, &a, &b)
}

// ------------------------------------------------------------------ fixture replay

#[test]
fn fixture_season_replay_matches_fixture_views() {
    let season_fx = fx("season");
    let mut chain = Chain { ts: season_fx["opened_at_ns"].as_str().unwrap().parse::<u64>().unwrap() - 1, height: 277_078_000 };
    let mut c = new_contract(&chain);
    for a in fx("agents").as_array().unwrap() {
        register(&mut c, &chain, a["name"].as_str().unwrap(), a["owner"].as_str().unwrap(), 5);
    }
    let sid = open(&mut c, &mut chain, params_from_fixture());
    assert_eq!(sid, 1);
    assert!(event_names().contains(&"season_opened".to_string()));
    for e in fx("entries").as_array().unwrap() {
        let id = acc(e["agent_id"].as_str().unwrap());
        chain.call(id.as_str());
        let parent: Option<Parent> = serde_json::from_value(e["parent"].clone()).unwrap();
        c.commit(
            sid,
            id,
            e["ciphertext_hex"].as_str().unwrap().into(),
            e["commitment"].as_str().unwrap().into(),
            e["family"].as_str().unwrap().into(),
            parent,
        );
        assert_eq!(event_names(), vec!["committed"]);
    }
    let s = c.get_season(sid).unwrap();
    assert_eq!(serde_json::to_value(s.entry_deposit_yocto).unwrap(), season_fx["entry_deposit_yocto"]);

    chain.ts = season_fx["closed_at_ns"].as_str().unwrap().parse::<u64>().unwrap() + 1;
    chain.call(KEEPER);
    assert_eq!(c.close_commits(sid), 6);
    let s = c.get_season(sid).unwrap();
    assert_eq!(serde_json::to_value(s.stake_per_agent_yocto).unwrap(), season_fx["stake_per_agent_yocto"]);
    assert_eq!(s.total_rounds, 5);
    for _ in 0..5 {
        assert_eq!(c.schedule_round(sid).len(), 3);
    }

    // Scheduled order and keys equal fixtures/matches.json.
    let fx_matches = fx("matches");
    let ours = c.get_matches(sid, None, None, None);
    assert_eq!(ours.len(), 15);
    for (m, f) in ours.iter().zip(fx_matches.as_array().unwrap()) {
        assert_eq!(m.match_key, f["match_key"].as_str().unwrap());
        assert_eq!(m.round as u64, f["round"].as_u64().unwrap());
    }

    // Play every match with the fixture WASM output; check the play_match input against the fixture input.
    let outputs = fx("outputs");
    let inputs = fx("inputs");
    for (i, m) in ours.iter().enumerate() {
        let out = outputs.as_array().unwrap().iter().find(|o| o["match_key"] == m.match_key.as_str()).unwrap();
        let fin = inputs.as_array().unwrap().iter().find(|o| o["match_key"] == m.match_key.as_str()).unwrap();
        // Input as the contract would send it (built the same way as in play_match).
        let ea = c.get_entries(sid, None, None).into_iter().find(|e| e.agent_id == m.a).unwrap();
        assert_eq!(fin["hash_a"].as_str().unwrap(), ea.commitment);
        assert_eq!(fin["ct_a"].as_str().unwrap(), ea.ciphertext_hex);
        let r = play(&mut c, &mut chain, sid, &m.a, &m.b, Some(&out.to_string()));
        let f = &fx_matches[i];
        let got = serde_json::to_value(c.get_matches(sid, Some(i as u32), Some(1), None)[0].clone()).unwrap();
        for k in [
            "status", "a_move", "b_move", "a_payoff", "b_payoff", "pool_delta", "sig_a_ok", "sig_b_ok", "a_chat_id",
            "b_chat_id", "a_signed_text", "b_signed_text", "a_sig", "b_sig", "void_reason",
        ] {
            assert_eq!(got[k], f[k], "match {} field {k}", m.match_key);
        }
        if f["status"] == "void" {
            assert_eq!(r, "void");
            assert_eq!(event_names(), vec!["match_void"]);
        } else {
            assert_eq!(r, format!("settled {}{}", f["a_move"].as_str().unwrap(), f["b_move"].as_str().unwrap()));
            assert_eq!(event_names(), vec!["match_played"]);
        }
    }
    let s = c.get_season(sid).unwrap();
    assert_eq!((s.n_settled, s.n_void), (14, 1));
    assert_eq!(serde_json::to_value(s.pool_yocto).unwrap(), season_fx["pool_yocto"]);

    // Live leaderboard has ranks, no prizes yet.
    assert!(c.get_leaderboard(sid).iter().all(|r| r.prize_yocto.0 == 0));

    chain.ts += 1;
    chain.call(KEEPER);
    let rows = c.settle_season(sid);
    assert_eq!(serde_json::to_value(&rows).unwrap(), fx("leaderboard"));
    assert_eq!(event_names(), vec!["season_settled"]);
    assert_eq!(c.get_season(sid).unwrap().status, SeasonStatus::Settled);

    // Lineage per agent matches the fixture.
    for l in fx("lineage").as_array().unwrap() {
        let got = c.get_lineage(acc(l["agent_id"].as_str().unwrap()));
        assert_eq!(serde_json::to_value(&got[0]).unwrap(), *l);
    }

    // refund_void still works on the void match after settlement.
    let void = c.get_matches(sid, None, None, Some(MatchStatus::Void));
    assert_eq!(void.len(), 1);
    chain.call(KEEPER);
    let per_side = c.refund_void(sid, void[0].a.clone(), void[0].b.clone());
    assert_eq!(per_side.0, 3 * 10u128.pow(22));

    // Money is conserved: every yocto of the 6 entry deposits is claimable (pool paid out fully).
    let entry_deposit = c.get_season(sid).unwrap().entry_deposit_yocto.0;
    let total: u128 = fx("agents")
        .as_array()
        .unwrap()
        .iter()
        .map(|a| c.get_claimable(sid, acc(a["agent_id"].as_str().unwrap())).0)
        .sum();
    assert_eq!(total, 6 * entry_deposit);

    // claim moves claimable into the budget.
    let tft = acc(&format!("tft.{CONTRACT}"));
    let before = c.get_agent(tft.clone()).unwrap().budget_yocto.0;
    let cl = c.get_claimable(sid, tft.clone()).0;
    chain.call(tft.as_str());
    assert_eq!(c.claim(sid, tft.clone()).0, cl);
    assert_eq!(c.get_agent(tft.clone()).unwrap().budget_yocto.0, before + cl);
    assert_eq!(c.get_claimable(sid, tft).0, 0);

    // publish_prompt checks the salted commitment.
    for p in fx("prompts").as_array().unwrap() {
        let id = acc(p["agent_id"].as_str().unwrap());
        let owner = c.get_agent(id.clone()).unwrap().owner;
        chain.call(owner.as_str());
        c.publish_prompt(sid, id, p["prompt"].as_str().unwrap().into(), p["salt"].as_str().unwrap().into());
        assert_eq!(event_names(), vec!["prompt_published"]);
    }
    let published = c.get_published_prompts(sid, None, None);
    assert_eq!(published.len(), fx("prompts").as_array().unwrap().len());
    for p in fx("prompts").as_array().unwrap() {
        let got = published.iter().find(|x| x.agent_id.as_str() == p["agent_id"].as_str().unwrap()).unwrap();
        assert_eq!(got.prompt, p["prompt"].as_str().unwrap());
        assert_eq!(got.salt, p["salt"].as_str().unwrap());
    }
    assert_eq!(c.get_published_prompts(sid, Some(1), Some(1)).len(), 1);
}

#[test]
fn ranking_excludes_same_owner_matches() {
    // tft and grim share alice in the fixture; also check directly in a small season.
    let (mut c, mut chain, sid, ids) =
        small_season(&[("a1", "alice.near"), ("a2", "alice.near"), ("b1", "bob.near"), ("c1", "carol.near")]);
    let (a1, a2, b1, c1) = (&ids[0], &ids[1], &ids[2], &ids[3]);
    // Self-owned match a1 vs a2: a1 defects for a 5.
    let k = mkey(sid, a1, a2);
    let (fa, _) = ordered(a1.clone(), a2.clone());
    let out = if &fa == a1 { out_for(&k, "D", "C") } else { out_for(&k, "C", "D") };
    play(&mut c, &mut chain, sid, a1, a2, Some(&out));
    for (x, y) in [(a1, b1), (a1, c1), (a2, b1), (a2, c1), (b1, c1)] {
        play(&mut c, &mut chain, sid, x, y, Some(&out_for(&mkey(sid, x, y), "C", "C")));
    }
    let a1_claim = c.get_claimable(sid, a1.clone()).0;
    let unit = 10u128.pow(22);
    // The self-owned match still pays out (5 + 3 + 3) ...
    assert_eq!(a1_claim, 11 * unit + c.get_season(sid).unwrap().entry_deposit_yocto.0 - 50_000_000_000_000_000_000_000 - 9 * unit);
    chain.call(KEEPER);
    let rows = c.settle_season(sid);
    let r1 = rows.iter().find(|r| &r.agent_id == a1).unwrap();
    // ... but only the 2 cross-owner matches count.
    assert_eq!((r1.matches_counted, r1.total_payoff_counted, r1.avg_payoff_milli), (2, 6, 3000));
    let rb = rows.iter().find(|r| &r.agent_id == b1).unwrap();
    assert_eq!(rb.matches_counted, 3);
}

#[test]
fn forfeit_rows_and_bond_to_pool() {
    let (mut c, mut chain, sid, ids) =
        small_season(&[("p1", "o1.near"), ("p2", "o2.near"), ("p3", "o3.near"), ("p4", "o4.near")]);
    let unit = 10u128.pow(22);
    let bond = 5 * unit;
    let (p1, p2, p3, p4) = (&ids[0], &ids[1], &ids[2], &ids[3]);
    // p1 forfeits everywhere (undecryptable ciphertext). Move strings are given in (a, b) key order.
    let cases = [(p1, p2, "F", "C"), (p1, p3, "F", "D"), (p1, p4, "F", "F"), (p2, p3, "D", "D"), (p2, p4, "C", "D"), (p3, p4, "D", "C")];
    let mut pool = 0u128;
    for (x, y, mx, my) in cases {
        let (a, _) = ordered(x.clone(), y.clone());
        let (ma, mb) = if &a == x { (mx, my) } else { (my, mx) };
        let r = play(&mut c, &mut chain, sid, x, y, Some(&out_for(&mkey(sid, x, y), ma, mb)));
        assert_eq!(r, format!("settled {ma}{mb}"));
        let (pa, pb, pd) = payoff(Move::parse(ma).unwrap(), Move::parse(mb).unwrap());
        let m = &c.get_matches(sid, None, None, None).into_iter().find(|m| m.match_key == mkey(sid, x, y)).unwrap();
        assert_eq!((m.a_payoff, m.b_payoff, m.pool_delta), (pa, pb, pd));
        pool += pd as u128 * unit;
    }
    // F/C 3, F/D 3, F/F 6, D/D 4, C/D 0, D/C 0
    assert_eq!(pool, 16 * unit);
    assert_eq!(c.get_season(sid).unwrap().pool_yocto.0, pool);
    chain.call(KEEPER);
    let rows = c.settle_season(sid);
    let s = c.get_season(sid).unwrap();
    // p1 (F everywhere) and p4 (F vs p1) forfeited: both bonds go to the pool.
    assert_eq!(s.pool_yocto.0, pool + 2 * bond, "forfeited bonds go to the pool");
    // p1 gets 0 payoff and no bond back; still ranked (counted matches with payoff 0).
    let r1 = rows.iter().find(|r| &r.agent_id == p1).unwrap();
    assert_eq!((r1.total_payoff_counted, r1.avg_payoff_milli), (0, 0));
    let total: u128 = ids.iter().map(|i| c.get_claimable(sid, i.clone()).0).sum();
    assert_eq!(total, 4 * s.entry_deposit_yocto.0, "conserved");
}

#[test]
fn one_shot_replay_refused() {
    let (mut c, mut chain, sid, ids) =
        small_season(&[("p1", "o1.near"), ("p2", "o2.near"), ("p3", "o3.near"), ("p4", "o4.near")]);
    let (a, b) = (&ids[0], &ids[1]);
    play(&mut c, &mut chain, sid, a, b, Some(&out_for(&mkey(sid, a, b), "C", "C")));
    chain.pay(KEEPER, MIN_OUTLAYER_DEPOSIT);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.play_match(sid, b.clone(), a.clone()); // reversed order is the same key
    }));
    assert!(r.is_err());
}

#[test]
fn replay_after_void_and_pending_refused() {
    let (mut c, mut chain, sid, ids) =
        small_season(&[("p1", "o1.near"), ("p2", "o2.near"), ("p3", "o3.near"), ("p4", "o4.near")]);
    let (a, b) = (&ids[0], &ids[1]);
    assert_eq!(play(&mut c, &mut chain, sid, a, b, None), "void");
    for _ in 0..2 {
        chain.pay(KEEPER, MIN_OUTLAYER_DEPOSIT);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = c.play_match(sid, a.clone(), b.clone());
        }));
        assert!(r.is_err(), "no path from void back to scheduled");
    }
    // pending can't be replayed either
    let (x, y) = (&ids[2], &ids[3]);
    chain.pay(KEEPER, MIN_OUTLAYER_DEPOSIT);
    let _ = c.play_match(sid, x.clone(), y.clone());
    chain.pay(KEEPER, MIN_OUTLAYER_DEPOSIT);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.play_match(sid, x.clone(), y.clone());
    }));
    assert!(r.is_err());
}

#[test]
fn void_reasons_and_refund() {
    let (mut c, mut chain, sid, _ids) =
        small_season(&[("p1", "o1.near"), ("p2", "o2.near"), ("p3", "o3.near"), ("p4", "o4.near")]);
    let unit = 10u128.pow(22);
    let pairs: Vec<(AccountId, AccountId)> =
        c.get_matches(sid, None, None, None).into_iter().map(|m| (m.a, m.b)).collect();
    let cases: Vec<(Option<String>, &str)> = vec![
        (None, "callback_failed"),
        (Some("not json".into()), "bad_output"),
        (Some(json!({"match_key": "1:x:y", "a_move": "C", "b_move": "C"}).to_string()), "match_key_mismatch"),
        (Some(json!({"match_key": mkey(sid, &pairs[3].0, &pairs[3].1), "error": "duplicate_prompt"}).to_string()), "duplicate_prompt"),
        (Some(json!({"match_key": mkey(sid, &pairs[4].0, &pairs[4].1), "a_move": "X", "b_move": "C"}).to_string()), "bad_output"),
        (Some(json!({"match_key": mkey(sid, &pairs[5].0, &pairs[5].1), "error": "llm_status_503"}).to_string()), "llm_status_503"),
    ];
    for (i, (res, reason)) in cases.iter().enumerate() {
        let (a, b) = &pairs[i];
        assert_eq!(play(&mut c, &mut chain, sid, a, b, res.as_deref()), "void");
        let m = c.get_matches(sid, Some(i as u32), Some(1), None).remove(0);
        assert_eq!((m.status, m.void_reason.as_deref()), (MatchStatus::Void, Some(*reason)));
        let ev: Value = serde_json::from_str(get_logs()[0].strip_prefix("EVENT_JSON:").unwrap()).unwrap();
        assert_eq!(ev["event"], "match_void");
        assert_eq!(ev["data"][0]["reason"], *reason);
    }
    let a = &pairs[0].0;
    let before = c.get_claimable(sid, a.clone()).0;
    chain.call(KEEPER);
    assert_eq!(c.refund_void(sid, pairs[0].0.clone(), pairs[0].1.clone()).0, 3 * unit);
    assert_eq!(c.get_claimable(sid, a.clone()).0, before + 3 * unit);
    assert_eq!(c.get_matches(sid, Some(0), Some(1), None)[0].status, MatchStatus::Refunded);
    // second refund refused
    chain.call(KEEPER);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.refund_void(sid, pairs[0].0.clone(), pairs[0].1.clone());
    }));
    assert!(r.is_err());
}

#[test]
fn duplicate_prompt_fixture_voids() {
    let dup = fx("dup");
    let mk = dup["output"]["match_key"].as_str().unwrap();
    assert_eq!(parse_match_result(Some(dup["output"].to_string().as_bytes()), mk), Err("duplicate_prompt".into()));
}

#[test]
fn stale_pending_refund_and_deadline_settle() {
    let (mut c, mut chain, sid, ids) =
        small_season(&[("p1", "o1.near"), ("p2", "o2.near"), ("p3", "o3.near"), ("p4", "o4.near")]);
    let (a, b) = ordered(ids[0].clone(), ids[1].clone());
    chain.pay(KEEPER, MIN_OUTLAYER_DEPOSIT);
    let _ = c.play_match(sid, a.clone(), b.clone());
    chain.height += STALE_PENDING_BLOCKS;
    chain.call(KEEPER);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.refund_void(sid, a.clone(), b.clone());
    }))
    .is_err(), "not stale yet");
    chain.height += 1;
    chain.call(KEEPER);
    c.refund_void(sid, a.clone(), b.clone());
    assert_eq!(event_names(), vec!["match_void"]);
    let m = c.get_matches(sid, None, None, Some(MatchStatus::Refunded)).remove(0);
    assert_eq!(m.void_reason.as_deref(), Some("stale_pending"));
    // late callback after refund is refused
    chain.callback(Some(&out_for(&m.match_key, "C", "C")));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.on_match(sid, a.clone(), b.clone());
    }))
    .is_err());

    // settle before play deadline with unfinished matches is refused; after, they are voided.
    chain.call(KEEPER);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.settle_season(sid);
    }))
    .is_err());
    chain.ts = 20_000;
    chain.call(KEEPER);
    let rows = c.settle_season(sid);
    assert!(rows.iter().all(|r| r.rank.is_none() && r.prize_yocto.0 == 0));
    let s = c.get_season(sid).unwrap();
    assert_eq!(s.n_void, 6);
    let total: u128 = ids.iter().map(|i| c.get_claimable(sid, i.clone()).0).sum();
    assert_eq!(total, 4 * s.entry_deposit_yocto.0);
}

#[test]
fn unscheduled_rounds_refunded_at_deadline() {
    let mut chain = Chain { ts: 1_000, height: 100 };
    let mut c = new_contract(&chain);
    let ids: Vec<AccountId> =
        (0..5).map(|i| register(&mut c, &chain, &format!("n{i}"), &format!("o{i}.near"), 2)).collect();
    let mut p = params_from_fixture();
    p.commit_deadline_ns = U64(10_000);
    p.play_deadline_ns = U64(20_000);
    p.max_agents = 5;
    let sid = open(&mut c, &mut chain, p);
    for id in &ids {
        chain.call(id.as_str());
        c.commit(sid, id.clone(), "04ab".into(), "cd".repeat(32), "fam".into(), None);
    }
    chain.ts = 10_001;
    chain.call(KEEPER);
    c.close_commits(sid);
    assert_eq!(c.get_season(sid).unwrap().total_rounds, 5); // odd → N rounds with a bye
    assert_eq!(c.schedule_round(sid).len(), 2);
    chain.ts = 20_000;
    chain.call(KEEPER);
    c.settle_season(sid);
    let s = c.get_season(sid).unwrap();
    let total: u128 = ids.iter().map(|i| c.get_claimable(sid, i.clone()).0).sum();
    assert_eq!(total, 5 * s.entry_deposit_yocto.0);
}

// `#[private]` is enforced by the generated wasm entry point, not by the Rust method, so the
// non-self-caller checks for on_match / on_pubkey / on_agent_created live in tests/integration.rs.

fn expect_panic<F: FnOnce()>(f: F, msg: &str) {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    let e = r.expect_err(&format!("expected panic: {msg}"));
    let s = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|x| x.to_string())).unwrap_or_default();
    assert!(s.contains(msg), "panic {s:?} does not contain {msg:?}");
}

#[test]
fn commit_rules() {
    let mut chain = Chain { ts: 1_000, height: 100 };
    let mut c = new_contract(&chain);
    let a1 = register(&mut c, &chain, "a1", "alice.near", 2);
    let a2 = register(&mut c, &chain, "a2", "alice.near", 2);
    let b1 = register(&mut c, &chain, "b1", "bob.near", 2);
    let poor = register(&mut c, &chain, "poor", "carol.near", 1);
    let mut p = params_from_fixture();
    p.commit_deadline_ns = U64(10_000);
    p.play_deadline_ns = U64(20_000);
    p.max_entries_per_owner = 1;
    let sid = open(&mut c, &mut chain, p);
    let commit = |c: &mut Dilemma, who: &str, id: &AccountId, ct: &str, fam: &str| {
        Chain { ts: near_sdk::env::block_timestamp(), height: 100 }.call(who);
        c.commit(sid, id.clone(), ct.into(), "cd".repeat(32), fam.into(), None)
    };
    expect_panic(|| commit(&mut c, "mallory.near", &a1, "04ab", "f"), "caller must be the agent or its owner");
    expect_panic(|| commit(&mut c, a1.as_str(), &a1, "04AB", "f"), "bad ciphertext_hex");
    expect_panic(|| commit(&mut c, a1.as_str(), &a1, &"ab".repeat(4201), "f"), "bad ciphertext_hex");
    expect_panic(|| commit(&mut c, a1.as_str(), &a1, "04ab", "Bad-Fam"), "bad family");
    // owner can commit for its agent
    commit(&mut c, "alice.near", &a1, "04ab", "f");
    let budget = c.get_agent(a1.clone()).unwrap().budget_yocto.0;
    assert_eq!(budget, NearToken::from_near(2).as_yoctonear() - AGENT_ACCOUNT_FUNDING.as_yoctonear() - c.get_season(sid).unwrap().entry_deposit_yocto.0);
    expect_panic(|| commit(&mut c, a1.as_str(), &a1, "04ab", "f"), "agent already entered");
    expect_panic(|| commit(&mut c, a2.as_str(), &a2, "04ab", "f"), "owner reached max_entries_per_owner");
    expect_panic(|| commit(&mut c, poor.as_str(), &poor, "04ab", "f"), "budget < entry_deposit_yocto");
    chain.ts = 10_001;
    chain.call(KEEPER);
    expect_panic(|| commit(&mut c, b1.as_str(), &b1, "04ab", "f"), "commit deadline passed");
    // close with 1 entry → cancelled, deposit claimable
    chain.call(KEEPER);
    assert_eq!(c.close_commits(sid), 1);
    assert_eq!(c.get_season(sid).unwrap().status, SeasonStatus::Cancelled);
    assert_eq!(c.get_claimable(sid, a1.clone()).0, c.get_season(sid).unwrap().entry_deposit_yocto.0);
    // a new season may open after a cancelled one
    let mut p2 = params_from_fixture();
    p2.commit_deadline_ns = U64(30_000);
    p2.play_deadline_ns = U64(40_000);
    assert_eq!(open(&mut c, &mut chain, p2), 2);
}

#[test]
fn open_season_rules() {
    let chain = Chain { ts: 1_000, height: 100 };
    let mut c = new_contract(&chain);
    let mut p = params_from_fixture();
    p.commit_deadline_ns = U64(10_000);
    p.play_deadline_ns = U64(20_000);
    chain.pay("mallory.near", MIN_OUTLAYER_DEPOSIT);
    expect_panic(|| { c.open_season(p.clone()); }, "owner only");
    chain.pay(OWNER, NearToken::from_millinear(1));
    expect_panic(|| { c.open_season(p.clone()); }, "attach >= 0.02 NEAR");
    let mut bad = p.clone();
    bad.prize_split_bps = vec![5000, 4000];
    chain.pay(OWNER, MIN_OUTLAYER_DEPOSIT);
    expect_panic(|| { c.open_season(bad); }, "prize_split_bps must sum to 10000");
    let mut bad = p.clone();
    bad.max_agents = 41;
    expect_panic(|| { c.open_season(bad); }, "max_agents");
    chain.pay(OWNER, MIN_OUTLAYER_DEPOSIT);
    let sid = c.open_season(p.clone());
    assert_eq!(c.get_season(sid).unwrap().status, SeasonStatus::PendingKey);
    expect_panic(|| { c.open_season(p.clone()); }, "previous season not finished");
    // key derivation failure → key_failed, then a new season may open
    chain.callback(Some(r#"{"error":"no_seed"}"#));
    assert_eq!(c.on_pubkey(sid), None);
    assert_eq!(c.get_season(sid).unwrap().status, SeasonStatus::KeyFailed);
    assert_eq!(c.get_season_pubkey(sid), None);
    chain.pay(OWNER, MIN_OUTLAYER_DEPOSIT);
    assert_eq!(c.open_season(p), 2);
    // wasm + secrets snapshot
    let s = c.get_season(2).unwrap();
    assert_eq!(s.wasm, WasmSource { url: "https://example/referee.wasm".into(), hash: "ab".repeat(32) });
}

#[test]
fn register_agent_rules_and_budget() {
    let chain = Chain { ts: 1_000, height: 100 };
    let mut c = new_contract(&chain);
    let pk: PublicKey = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap();
    chain.pay("alice.near", NearToken::from_millinear(249));
    expect_panic(|| { let _ = c.register_agent("tft".into(), pk.clone()); }, "attach >= 0.25 NEAR");
    chain.pay("alice.near", NearToken::from_near(1));
    expect_panic(|| { let _ = c.register_agent("T".into(), pk.clone()); }, "invalid name");
    let id = register(&mut c, &chain, "tft", "alice.near", 1);
    assert_eq!(event_names(), vec!["agent_registered"]);
    chain.pay("bob.near", NearToken::from_near(1));
    expect_panic(|| { let _ = c.register_agent("tft".into(), pk.clone()); }, "name taken");
    let a = c.get_agent(id.clone()).unwrap();
    assert_eq!(a.owner, acc("alice.near"));
    assert_eq!(a.budget_yocto.0, NearToken::from_millinear(800).as_yoctonear());
    // fund + withdraw
    chain.pay("anyone.near", NearToken::from_near(1));
    assert_eq!(c.fund_agent(id.clone()).0, NearToken::from_millinear(1800).as_yoctonear());
    chain.pay("bob.near", NearToken::from_yoctonear(1));
    expect_panic(|| { c.withdraw(id.clone(), U128(1)); }, "not owner");
    chain.pay("alice.near", NearToken::from_yoctonear(0));
    expect_panic(|| { c.withdraw(id.clone(), U128(1)); }, "Requires attached deposit of exactly 1 yoctoNEAR");
    chain.pay("alice.near", NearToken::from_yoctonear(1));
    expect_panic(|| { c.withdraw(id.clone(), U128(10u128.pow(30))); }, "amount > budget");
    assert_eq!(c.withdraw(id.clone(), U128(NearToken::from_millinear(800).as_yoctonear())).0, 10u128.pow(24));
    // failed sub-account creation: name released, deposit refunded (no agent recorded)
    chain.pay("carol.near", NearToken::from_near(1));
    let _ = c.register_agent("grim".into(), pk);
    chain.callback(None);
    let gid = acc(&format!("grim.{CONTRACT}"));
    assert_eq!(c.on_agent_created(gid.clone(), acc("carol.near"), "grim".into(), U128(10u128.pow(24))), None);
    assert!(c.get_agent(gid).is_none());
    // agent account itself cannot withdraw (owner only)
    chain.pay(id.as_str(), NearToken::from_yoctonear(1));
    expect_panic(|| { c.withdraw(id.clone(), U128(1)); }, "not owner");
}

#[test]
fn publish_prompt_rejects_bad_salt_or_prompt() {
    let (mut c, mut chain, sid, ids) = small_season(&[("p1", "o1.near"), ("p2", "o2.near")]);
    let _ = &mut chain;
    let id = &ids[0];
    chain.call("o1.near");
    expect_panic(|| c.publish_prompt(sid, id.clone(), "x".into(), "00".repeat(32)), "season not settled");
    let (a, b) = (&ids[0], &ids[1]);
    play(&mut c, &mut chain, sid, a, b, Some(&out_for(&mkey(sid, a, b), "C", "C")));
    chain.call(KEEPER);
    c.settle_season(sid);
    chain.call("o1.near");
    expect_panic(|| c.publish_prompt(sid, id.clone(), "x".into(), "00".repeat(32)), "commitment mismatch");
    chain.call("o2.near");
    expect_panic(|| c.publish_prompt(sid, id.clone(), "x".into(), "00".repeat(32)), "not owner");
}

#[test]
fn signature_flag_only() {
    let chain = Chain { ts: 1, height: 1 };
    let _c = new_contract(&chain);
    let out = &fx("outputs")[0];
    let signer = signer_hex();
    assert!(check_sig(&signer, out["a_signed_text"].as_str().unwrap(), out["a_sig"].as_str().unwrap()));
    assert!(!check_sig(&signer, out["b_signed_text"].as_str().unwrap(), out["a_sig"].as_str().unwrap()));
    assert!(!check_sig(&signer, "", ""));
    assert!(!check_sig(&signer, "x", &"zz".repeat(64)));
    // Bad signature still settles (flag false).
    let mut o = out.clone();
    o["a_sig"] = json!("11".repeat(64));
    let mk = o["match_key"].as_str().unwrap().to_string();
    let parsed = parse_match_result(Some(o.to_string().as_bytes()), &mk).unwrap();
    assert!(!check_sig(&signer, &parsed.a_signed_text, &parsed.a_sig));
}

#[test]
fn parse_output_variants() {
    let mk = "1:a.x:b.x";
    let ok = out_for(mk, "D", "F");
    assert_eq!(parse_match_result(Some(ok.as_bytes()), mk).unwrap().b_move, Move::F);
    // output delivered as a JSON string
    let wrapped = serde_json::to_string(&ok).unwrap();
    assert!(parse_match_result(Some(wrapped.as_bytes()), mk).is_ok());
    assert_eq!(parse_match_result(None, mk), Err("callback_failed".into()));
    assert_eq!(parse_match_result(Some(b"null"), mk), Err("bad_output".into()));
    assert_eq!(parse_match_result(Some(br#"{"match_key":"1:a.x:b.x","error":"whatever"}"#), mk), Err("bad_output".into()));
    assert_eq!(parse_match_result(Some(br#"{"error":"llm_timeout"}"#), mk), Err("llm_timeout".into()));
    assert_eq!(parse_match_result(Some(br#"{"a_move":"C","b_move":"C"}"#), mk), Err("match_key_mismatch".into()));
    let long = json!({"match_key": mk, "a_move": "C", "b_move": "C", "a_chat_id": "x".repeat(65), "b_chat_id": "",
        "a_signed_text": "", "b_signed_text": "", "a_sig": "", "b_sig": ""});
    assert_eq!(parse_match_result(Some(long.to_string().as_bytes()), mk), Err("bad_output".into()));
}

#[test]
fn schedule_round_rules() {
    let (mut c, chain, sid, _) = small_season(&[("p1", "o1.near"), ("p2", "o2.near"), ("p3", "o3.near")]);
    chain.call(KEEPER);
    expect_panic(|| { c.schedule_round(sid); }, "all rounds scheduled");
    let s = c.get_season(sid).unwrap();
    assert_eq!((s.total_rounds, s.n_matches), (3, 3));
    // pagination + status filter
    assert_eq!(c.get_matches(sid, Some(1), Some(1), None).len(), 1);
    assert_eq!(c.get_matches(sid, None, None, Some(MatchStatus::Scheduled)).len(), 3);
    assert_eq!(c.get_entries(sid, Some(2), Some(5)).len(), 1);
    assert!(c.get_season(99).is_none());
}

#[test]
fn config_view() {
    let chain = Chain { ts: 1, height: 1 };
    let c = new_contract(&chain);
    let v = serde_json::to_value(c.get_config()).unwrap();
    assert_eq!(v["owner"], OWNER);
    assert_eq!(v["outlayer_account"], "outlayer.testnet");
    assert_eq!(v["current_season_id"], Value::Null);
    assert_eq!(v["nearai_signer"], signer_hex());
}

#[test]
fn settle_at_deadline_batches_voids_under_log_limit() {
    let mut chain = Chain { ts: 1_000, height: 100 };
    let mut c = new_contract(&chain);
    let ids: Vec<AccountId> =
        (0..40).map(|i| register(&mut c, &chain, &format!("n{i:02}"), &format!("o{i}.near"), 2)).collect();
    let mut p = params_from_fixture();
    p.commit_deadline_ns = U64(10_000);
    p.play_deadline_ns = U64(20_000);
    let sid = open(&mut c, &mut chain, p);
    for id in &ids {
        chain.call(id.as_str());
        c.commit(sid, id.clone(), "04ab".into(), "cd".repeat(32), "fam".into(), None);
    }
    chain.ts = 10_001;
    chain.call(KEEPER);
    c.close_commits(sid);
    for _ in 0..39 {
        assert_eq!(c.schedule_round(sid).len(), 20);
    }
    // settle one match so ranking is non-trivial
    let (a, b) = (ids[0].clone(), ids[39].clone());
    play(&mut c, &mut chain, sid, &a, &b, Some(&out_for(&mkey(sid, &a, &b), "C", "C")));
    chain.ts = 20_000;
    let mut calls = 0;
    loop {
        chain.call(KEEPER);
        let rows = c.settle_season(sid);
        calls += 1;
        let logs = get_logs();
        assert!(logs.len() <= 100, "log count {}", logs.len());
        assert!(logs.iter().map(|l| l.len()).sum::<usize>() <= 16_384, "log bytes");
        if !rows.is_empty() {
            assert_eq!(rows.len(), 40);
            break;
        }
        assert_eq!(c.get_season(sid).unwrap().status, SeasonStatus::Play);
        assert!(calls < 30);
    }
    assert_eq!(calls, 20); // 19 calls × 40 voids, then 19 voids + ranking in the 20th
    let s = c.get_season(sid).unwrap();
    assert_eq!((s.status, s.n_void, s.n_settled), (SeasonStatus::Settled, 779, 1));
    let total: u128 = ids.iter().map(|i| c.get_claimable(sid, i.clone()).0).sum();
    assert_eq!(total, 40 * s.entry_deposit_yocto.0);
}
