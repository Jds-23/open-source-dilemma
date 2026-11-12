//! near-workspaces sandbox tests for the dilemma contract against a mock OutLayer
//! (`tests/mock-outlayer`, which returns canned referee outputs per `match_key`).
//!
//! Both wasms are built here with plain `cargo` (`-C target-cpu=mvp`), then re-encoded with
//! `walrus` so the sandbox (nearcore 2.6, MVP wasm parser) accepts rustc 1.85 output.
//! Real deploys use `cargo near build` (see ops/).
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, AccessKeyPermission, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

const SANDBOX_VERSION: &str = "2.6.5";
const UNIT: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR
const BOND: u128 = 5 * UNIT;

// ------------------------------------------------------------------ build

fn build_wasm(manifest_dir: &Path, artifact: &str) -> Vec<u8> {
    let target_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/wasm-it");
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let status = Command::new(cargo)
        .current_dir(manifest_dir)
        .args(["build", "--locked", "--release", "--target", "wasm32-unknown-unknown", "--lib", "--target-dir"])
        .arg(&target_dir)
        .env("RUSTFLAGS", "-C link-arg=-s -C target-cpu=mvp")
        .env_remove("CARGO_ENCODED_RUSTFLAGS")
        .env_remove("CARGO_TARGET_DIR")
        .status()
        .expect("spawn cargo");
    assert!(status.success(), "wasm build failed for {}", manifest_dir.display());
    let path: PathBuf = target_dir.join("wasm32-unknown-unknown/release").join(artifact);
    let mut module = walrus::Module::from_file(&path).expect("parse wasm");
    module.emit_wasm()
}

fn wasms() -> &'static (Vec<u8>, Vec<u8>) {
    static W: OnceLock<(Vec<u8>, Vec<u8>)> = OnceLock::new();
    W.get_or_init(|| {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let dilemma = build_wasm(root, "dilemma_contract.wasm");
        let mock = build_wasm(&root.join("tests/mock-outlayer"), "mock_outlayer.wasm");
        (dilemma, mock)
    })
}

fn fx(name: &str) -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../interfaces/fixtures").join(name);
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// Gas burnt per method (max over calls), printed by the flow test for SDK defaults.
fn gas_log() -> &'static Mutex<BTreeMap<String, u64>> {
    static G: OnceLock<Mutex<BTreeMap<String, u64>>> = OnceLock::new();
    G.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn record_gas(method: &str, r: &ExecutionFinalResult) {
    let g = r.total_gas_burnt.as_gas();
    let mut m = gas_log().lock().unwrap();
    let e = m.entry(method.to_string()).or_insert(0);
    *e = (*e).max(g);
}

// ------------------------------------------------------------------ env

struct Env {
    w: Worker<Sandbox>,
    admin: Account,
    keeper: Account,
    osd: Contract,
    mock: Contract,
}

async fn sub(root: &Account, name: &str, near: u128) -> anyhow::Result<Account> {
    Ok(root.create_subaccount(name).initial_balance(NearToken::from_near(near)).transact().await?.into_result()?)
}

async fn setup() -> anyhow::Result<Env> {
    let (dilemma_wasm, mock_wasm) = wasms();
    let w = near_workspaces::sandbox_with_version(SANDBOX_VERSION).await?;
    let root = w.root_account()?;
    let admin = sub(&root, "admin", 50).await?;
    let keeper = sub(&root, "keeper", 50).await?;
    let mock = sub(&root, "outlayer", 20).await?.deploy(mock_wasm).await?.into_result()?;
    mock.call("new").transact().await?.into_result()?;
    let osd = sub(&root, "osd", 80).await?.deploy(dilemma_wasm).await?.into_result()?;
    admin
        .call(osd.id(), "new")
        .args_json(json!({
            "wasm_url": "https://test.fastfs.io/osd/referee.wasm",
            "wasm_hash": "ab".repeat(32),
            "secrets_owner": admin.id(),
            "secrets_profile": "osd-test",
            "nearai_signer": fx("test-nearai-signer.json")["public_key_hex"],
            "outlayer_account": mock.id(),
        }))
        .transact()
        .await?
        .into_result()?;
    Ok(Env { w, admin, keeper, osd, mock })
}

impl Env {
    async fn view(&self, method: &str, args: Value) -> anyhow::Result<Value> {
        Ok(self.osd.view(method).args_json(args).await?.json()?)
    }

    /// Registers `<name>.<osd>` paid by `owner`; returns the agent signer (its FC key only).
    async fn register(&self, owner: &Account, name: &str, near: u128) -> anyhow::Result<Account> {
        let sk = SecretKey::from_random(KeyType::ED25519);
        let r = owner
            .call(self.osd.id(), "register_agent")
            .args_json(json!({"name": name, "agent_public_key": sk.public_key().to_string()}))
            .deposit(NearToken::from_near(near))
            .max_gas()
            .transact()
            .await?;
        record_gas("register_agent", &r);
        let id: AccountId = format!("{name}.{}", self.osd.id()).parse()?;
        assert_eq!(r.clone().into_result()?.json::<Option<AccountId>>()?, Some(id.clone()));
        assert!(r.logs().iter().any(|l| l.contains("\"event\":\"agent_registered\"")));
        Ok(Account::from_secret_key(id, sk, &self.w))
    }

    async fn now_ns(&self) -> anyhow::Result<u64> {
        Ok(self.w.view_block().await?.timestamp())
    }

    async fn wait_past(&self, ts: u64) -> anyhow::Result<()> {
        for _ in 0..200 {
            if self.now_ns().await? > ts {
                return Ok(());
            }
            self.w.fast_forward(20).await?;
        }
        anyhow::bail!("sandbox clock did not pass {ts}")
    }

    async fn open_season(&self, commit_secs: u64) -> anyhow::Result<(u32, u64)> {
        self.open_season_with(commit_secs, 3_600, 4, 3).await
    }

    async fn open_season_with(
        &self,
        commit_secs: u64,
        play_secs: u64,
        max_agents: u32,
        max_entries_per_owner: u32,
    ) -> anyhow::Result<(u32, u64)> {
        self.open_season_full(commit_secs, play_secs, max_agents, max_entries_per_owner, json!({})).await
    }

    /// `overrides` = optional `{wasm_url, wasm_hash, secrets_profile}` for this season.
    async fn open_season_full(
        &self,
        commit_secs: u64,
        play_secs: u64,
        max_agents: u32,
        max_entries_per_owner: u32,
        overrides: Value,
    ) -> anyhow::Result<(u32, u64)> {
        self.mock
            .call("set_output")
            .args_json(json!({"key": "derive_pubkey", "output": json!({"pubkey": fx("season.json")["pubkey"]}).to_string()}))
            .transact()
            .await?
            .into_result()?;
        let mut params = fx("season.json")["params"].clone();
        let deadline = self.now_ns().await? + commit_secs * 1_000_000_000;
        params["commit_deadline_ns"] = json!(deadline.to_string());
        params["play_deadline_ns"] = json!((deadline + play_secs * 1_000_000_000).to_string());
        params["max_agents"] = json!(max_agents);
        params["max_entries_per_owner"] = json!(max_entries_per_owner);
        let r = self
            .admin
            .call(self.osd.id(), "open_season")
            .args_json({
                let mut a = overrides.clone();
                a["params"] = params;
                a
            })
            .deposit(NearToken::from_millinear(20))
            .max_gas()
            .transact()
            .await?;
        record_gas("open_season", &r);
        assert!(r.logs().iter().any(|l| l.contains("\"event\":\"season_opened\"")), "{:?}", r.logs());
        let sid: u32 = r.into_result()?.json()?;
        let s = self.view("get_season", json!({"season_id": sid})).await?;
        assert_eq!(s["status"], "commit");
        let url = overrides.get("wasm_url").cloned().unwrap_or(json!("https://test.fastfs.io/osd/referee.wasm"));
        let hash = overrides.get("wasm_hash").cloned().unwrap_or(json!("ab".repeat(32)));
        assert_eq!(s["wasm"], json!({"url": url, "hash": hash}));
        Ok((sid, deadline))
    }
}

fn out(match_key: &str, a: &str, b: &str) -> String {
    let o = &fx("wasm-outputs.json")[0]; // real TEST-ONLY signatures → sig_ok true
    json!({"match_key": match_key, "a_move": a, "b_move": b,
           "a_chat_id": o["a_chat_id"], "b_chat_id": o["b_chat_id"],
           "a_signed_text": o["a_signed_text"], "b_signed_text": o["b_signed_text"],
           "a_sig": o["a_sig"], "b_sig": o["b_sig"]})
    .to_string()
}

fn ordered<'a>(x: &'a AccountId, y: &'a AccountId) -> (&'a AccountId, &'a AccountId) {
    if x <= y {
        (x, y)
    } else {
        (y, x)
    }
}

fn refused<E>(r: Result<ExecutionFinalResult, E>) -> bool {
    match r {
        Err(_) => true,
        Ok(r) => r.is_failure(),
    }
}

fn err_text(r: &ExecutionFinalResult) -> String {
    format!("{:?}", r.failures())
}

// ------------------------------------------------------------------ tests

#[tokio::test]
async fn full_season_flow() -> anyhow::Result<()> {
    let env = setup().await?;
    let root = env.w.root_account()?;
    let alice = sub(&root, "alice", 20).await?;
    let bob = sub(&root, "bob", 20).await?;
    let carol = sub(&root, "carol", 20).await?;

    let a1 = env.register(&alice, "a1", 2).await?;
    let a2 = env.register(&alice, "a2", 2).await?;
    let b1 = env.register(&bob, "b1", 2).await?;
    let c1 = env.register(&carol, "c1", 2).await?;
    let agents = [&a1, &a2, &b1, &c1];

    // Season 1 pins its own referee (override); config keeps the default.
    let pinned = json!({"wasm_url": "https://test.fastfs.io/osd/referee-s1.wasm", "wasm_hash": "cd".repeat(32), "secrets_profile": "osd-s1"});
    let (sid, deadline) = env.open_season_full(25, 3_600, 4, 3, pinned.clone()).await?;
    let entry_deposit: u128 =
        env.view("get_season", json!({"season_id": sid})).await?["entry_deposit_yocto"].as_str().unwrap().parse()?;
    assert_eq!(entry_deposit, BOND + 3 * UNIT * 3);

    // Agents commit with their scoped FC key; alice commits a2 as its owner.
    let entries = fx("entries.json");
    for (i, ag) in agents.iter().enumerate() {
        let signer: &Account = if i == 1 { &alice } else { ag };
        let r = signer
            .call(env.osd.id(), "commit")
            .args_json(json!({
                "season_id": sid, "agent_id": ag.id(),
                "ciphertext_hex": entries[i]["ciphertext_hex"], "commitment": entries[i]["commitment"],
                "family": entries[i]["family"], "parent": null,
            }))
            .gas(Gas::from_tgas(50))
            .transact()
            .await?;
        record_gas("commit", &r);
        assert!(r.is_success(), "commit {}: {}", ag.id(), err_text(&r));
        assert!(r.logs().iter().any(|l| l.contains("\"event\":\"committed\"")));
    }
    // Duplicate commit refused (one entry per agent, no overwrite).
    let r = a1
        .call(env.osd.id(), "commit")
        .args_json(json!({"season_id": sid, "agent_id": a1.id(), "ciphertext_hex": "04ab",
                          "commitment": "cd".repeat(32), "family": "x", "parent": null}))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?;
    assert!(r.is_failure() && err_text(&r).contains("agent already entered"));

    env.wait_past(deadline).await?;
    let r = env.keeper.call(env.osd.id(), "close_commits").args_json(json!({"season_id": sid})).max_gas().transact().await?;
    record_gas("close_commits", &r);
    assert_eq!(r.into_result()?.json::<u32>()?, 4);
    for _ in 0..3 {
        let r = env.keeper.call(env.osd.id(), "schedule_round").args_json(json!({"season_id": sid})).max_gas().transact().await?;
        record_gas("schedule_round", &r);
        assert_eq!(r.into_result()?.json::<Vec<Value>>()?.len(), 2);
    }
    let r = env.keeper.call(env.osd.id(), "schedule_round").args_json(json!({"season_id": sid})).max_gas().transact().await?;
    assert!(r.is_failure(), "all rounds scheduled");

    // Canned referee results per pair, written as (x, y) moves.
    let (ia1, ia2, ib1, ic1) = (a1.id(), a2.id(), b1.id(), c1.id());
    let plan: Vec<(&AccountId, &AccountId, Result<(&str, &str), &str>)> = vec![
        (ia1, ia2, Ok(("D", "C"))),               // same owner: pays, not ranked
        (ia1, ib1, Ok(("C", "C"))),
        (ia1, ic1, Ok(("D", "D"))),               // +4 pool
        (ia2, ib1, Ok(("F", "C"))),               // a2 forfeits: 0/3, +3 pool, bond lost
        (ia2, ic1, Err("duplicate_prompt")),      // TEE error → void
        (ib1, ic1, Err("__panic__")),             // OutLayer failure → callback_failed
    ];
    let mut keys = vec![];
    for (x, y, res) in &plan {
        let (a, b) = ordered(x, y);
        let mk = format!("{sid}:{a}:{b}");
        let output = match res {
            Ok((mx, my)) => {
                let (ma, mb) = if a == *x { (*mx, *my) } else { (*my, *mx) };
                out(&mk, ma, mb)
            }
            Err("__panic__") => "__panic__".to_string(),
            Err(code) => json!({"match_key": mk, "error": code}).to_string(),
        };
        env.mock.call("set_output").args_json(json!({"key": mk, "output": output})).transact().await?.into_result()?;
        keys.push((a.clone(), b.clone(), mk));
    }
    // F2: a low-gas play_match is refused before any state change; the match stays scheduled.
    {
        let (a, b, mk) = &keys[0];
        for tgas in [50, 209] {
            let r = env
                .keeper
                .call(env.osd.id(), "play_match")
                .args_json(json!({"season_id": sid, "a": a, "b": b}))
                .deposit(NearToken::from_millinear(20))
                .gas(Gas::from_tgas(tgas))
                .transact()
                .await?;
            assert!(r.is_failure() && err_text(&r).contains("insufficient gas: attach at least 210 Tgas"), "{tgas}: {}", err_text(&r));
            let ms = env.view("get_matches", json!({"season_id": sid})).await?;
            let m = ms.as_array().unwrap().iter().find(|m| m["match_key"] == mk.as_str()).unwrap();
            assert_eq!(m["status"], "scheduled");
            assert_eq!(env.mock.view("get_calls").args_json(json!({"key": mk})).await?.json::<u32>()?, 0);
        }
    }
    for (i, (a, b, mk)) in keys.iter().enumerate() {
        // pass reversed order sometimes: the contract normalises to a < b
        let (pa, pb) = if i % 2 == 0 { (a, b) } else { (b, a) };
        // The first match is played with exactly the F2 floor (210 Tgas), the rest with 300.
        let gas = if i == 0 { Gas::from_tgas(210) } else { Gas::from_tgas(300) };
        let r = env
            .keeper
            .call(env.osd.id(), "play_match")
            .args_json(json!({"season_id": sid, "a": pa, "b": pb}))
            .deposit(NearToken::from_millinear(20))
            .gas(gas)
            .transact()
            .await?;
        record_gas("play_match", &r);
        let ret: String = r.json()?;
        match &plan[i].2 {
            Ok(_) => assert!(ret.starts_with("settled "), "{mk}: {ret}"),
            Err(_) => assert_eq!(ret, "void", "{mk}"),
        }
        // A panicking mock call reverts its own counter, so the failed run records 0.
        let expect_calls = if matches!(plan[i].2, Err("__panic__")) { 0 } else { 1 };
        assert_eq!(env.mock.view("get_calls").args_json(json!({"key": mk})).await?.json::<u32>()?, expect_calls);
        if i == 0 {
            // OutLayer request carries the pinned source, secrets_ref and the schema input.
            let req: Value = serde_json::from_str(
                &env.mock.view("get_last_request").await?.json::<Option<String>>()?.unwrap(),
            )?;
            assert_eq!(req["predecessor"], env.osd.id().as_str());
            assert_eq!(req["payer_account_id"], env.keeper.id().as_str());
            assert_eq!(req["deposit"], NearToken::from_millinear(20).as_yoctonear().to_string());
            assert_eq!(
                req["source"],
                json!({"WasmUrl": {"url": pinned["wasm_url"], "hash": pinned["wasm_hash"], "build_target": "wasm32-wasip2"}})
            );
            assert_eq!(req["secrets_ref"], json!({"profile": "osd-s1", "account_id": env.admin.id()}));
            let input = &req["input"];
            let mut keys_in: Vec<&str> = input.as_object().unwrap().keys().map(|k| k.as_str()).collect();
            keys_in.sort();
            assert_eq!(
                keys_in,
                ["a", "action", "b", "ct_a", "ct_b", "hash_a", "hash_b", "match_key", "params", "referee_template_hash", "season"]
            );
            assert_eq!(input["action"], "play_match");
            assert_eq!(input["season"], sid);
            assert_eq!(input["match_key"], mk.as_str());
            assert_eq!(input["referee_template_hash"], fx("season.json")["params"]["referee_template_hash"]);
            assert_eq!(
                input["params"],
                json!({"model": fx("season.json")["params"]["model"], "temperature": 0, "seed": 42,
                       "max_tokens": 4, "enable_thinking": false, "max_prompt_bytes": 4000})
            );
            let ea = &entries[agents.iter().position(|ag| ag.id() == a).unwrap()];
            assert_eq!(input["ct_a"], ea["ciphertext_hex"]);
            assert_eq!(input["hash_a"], ea["commitment"]);
        }
    }

    // One-shot: replaying a settled or void match is refused, and OutLayer is not called again.
    for (a, b, mk) in [&keys[1], &keys[4]] {
        let r = env
            .keeper
            .call(env.osd.id(), "play_match")
            .args_json(json!({"season_id": sid, "a": a, "b": b}))
            .deposit(NearToken::from_millinear(20))
            .max_gas()
            .transact()
            .await?;
        assert!(r.is_failure() && err_text(&r).contains("match not scheduled"), "{mk}");
        assert_eq!(env.mock.view("get_calls").args_json(json!({"key": mk})).await?.json::<u32>()?, 1);
    }

    // Private callbacks reject outside callers.
    for (method, args) in [
        ("on_match", json!({"season_id": sid, "a": keys[1].0, "b": keys[1].1})),
        ("on_pubkey", json!({"season_id": sid})),
        ("on_agent_created", json!({"agent_id": a1.id(), "owner": env.keeper.id(), "name": "a1", "deposit": "1"})),
    ] {
        let r = env.keeper.call(env.osd.id(), method).args_json(args).max_gas().transact().await?;
        assert!(r.is_failure() && err_text(&r).contains(&format!("Method {method} is private")), "{method}: {}", err_text(&r));
    }

    // Match records.
    let matches = env.view("get_matches", json!({"season_id": sid})).await?;
    let by_key = |mk: &str| matches.as_array().unwrap().iter().find(|m| m["match_key"] == mk).unwrap().clone();
    let m_dd = by_key(&keys[2].2);
    assert_eq!((m_dd["a_payoff"].as_u64(), m_dd["b_payoff"].as_u64(), m_dd["pool_delta"].as_u64()), (Some(1), Some(1), Some(4)));
    assert_eq!((m_dd["sig_a_ok"].as_bool(), m_dd["sig_b_ok"].as_bool()), (Some(true), Some(true)));
    let m_f = by_key(&keys[3].2);
    assert_eq!(m_f["pool_delta"], 3);
    assert_eq!(by_key(&keys[4].2)["void_reason"], "duplicate_prompt");
    assert_eq!(by_key(&keys[5].2)["void_reason"], "callback_failed");

    // Void refund: 3 units per side; second refund refused.
    for (a, b, _) in [&keys[4], &keys[5]] {
        let r = env.keeper.call(env.osd.id(), "refund_void").args_json(json!({"season_id": sid, "a": a, "b": b})).max_gas().transact().await?;
        record_gas("refund_void", &r);
        assert_eq!(r.into_result()?.json::<String>()?, (3 * UNIT).to_string());
    }
    let r = env
        .keeper
        .call(env.osd.id(), "refund_void")
        .args_json(json!({"season_id": sid, "a": keys[4].0, "b": keys[4].1}))
        .max_gas()
        .transact()
        .await?;
    assert!(r.is_failure());

    // Settle: everything finished, so no need to wait for the play deadline.
    let r = env.keeper.call(env.osd.id(), "settle_season").args_json(json!({"season_id": sid})).max_gas().transact().await?;
    record_gas("settle_season", &r);
    assert!(r.logs().iter().any(|l| l.contains("\"event\":\"season_settled\"")));
    let rows: Vec<Value> = r.into_result()?.json()?;
    let row = |id: &AccountId| rows.iter().find(|r| r["agent_id"] == id.as_str()).unwrap().clone();
    // a1: counted only vs b1 (C/C 3) and c1 (D/D 1); the 5 vs same-owner a2 is excluded.
    assert_eq!((row(ia1)["matches_counted"].as_u64(), row(ia1)["total_payoff_counted"].as_u64()), (Some(2), Some(4)));
    assert_eq!(row(ia1)["avg_payoff_milli"], 2000);
    // a2: only vs b1 counted (F → 0); c1 match was void.
    assert_eq!((row(ia2)["matches_counted"].as_u64(), row(ia2)["total_payoff_counted"].as_u64()), (Some(1), Some(0)));
    // b1: a1 (3) + a2 (3) = 6 over 2 → rank 1.
    assert_eq!(row(ib1)["rank"], 1);
    assert_eq!(row(ib1)["avg_payoff_milli"], 3000);

    // Conservation: Σ claimable == 4 × entry_deposit (pool 4 + 3 + forfeited bond, split 50/30/20).
    let season = env.view("get_season", json!({"season_id": sid})).await?;
    let pool: u128 = season["pool_yocto"].as_str().unwrap().parse()?;
    assert_eq!(pool, 7 * UNIT + BOND);
    let mut total = 0u128;
    for ag in agents {
        let c: String = env.view("get_claimable", json!({"season_id": sid, "agent_id": ag.id()})).await?.as_str().unwrap().into();
        total += c.parse::<u128>()?;
    }
    assert_eq!(total, 4 * entry_deposit);

    // Claim with the agent's FC key moves claimable into the budget.
    let before: u128 = env.view("get_agent", json!({"agent_id": a1.id()})).await?["budget_yocto"].as_str().unwrap().parse()?;
    let r = a1.call(env.osd.id(), "claim").args_json(json!({"season_id": sid, "agent_id": a1.id()})).gas(Gas::from_tgas(30)).transact().await?;
    record_gas("claim", &r);
    let claimed: u128 = r.into_result()?.json::<String>()?.parse()?;
    let after: u128 = env.view("get_agent", json!({"agent_id": a1.id()})).await?["budget_yocto"].as_str().unwrap().parse()?;
    assert_eq!(after, before + claimed);

    // Owner withdraws to its own account.
    let r = alice
        .call(env.osd.id(), "withdraw")
        .args_json(json!({"agent_id": a1.id(), "amount_yocto": after.to_string()}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    record_gas("withdraw", &r);
    assert_eq!(r.into_result()?.json::<String>()?, "0");

    // Next season with the config default: season 1 keeps its pinned referee.
    let (sid2, _) = env.open_season(25).await?;
    let s1 = env.view("get_season", json!({"season_id": sid})).await?;
    assert_eq!(s1["wasm"], json!({"url": pinned["wasm_url"], "hash": pinned["wasm_hash"]}));
    assert_eq!(s1["secrets_profile"], "osd-s1");
    let s2 = env.view("get_season", json!({"season_id": sid2})).await?;
    assert_eq!(s2["secrets_profile"], "osd-test");
    // Season 1 paid its whole pool (3 ranked agents, 3 slots, no dust) → nothing carried.
    assert_eq!(s1["carry_over_yocto"], "0");
    assert_eq!(s2["carry_in_yocto"], "0");

    let g = gas_log().lock().unwrap();
    println!("GAS (Tgas burnt, max per call):");
    for (k, v) in g.iter() {
        println!("  {k:16} {:.2}", *v as f64 / 1e12);
    }
    Ok(())
}

#[tokio::test]
async fn scoped_agent_key_cannot_transfer_or_call_other_methods() -> anyhow::Result<()> {
    let env = setup().await?;
    let root = env.w.root_account()?;
    let alice = sub(&root, "alice", 20).await?;
    let agent = env.register(&alice, "tft", 1).await?;

    // Exactly one key: function-call, receiver = contract, methods = commit/claim, allowance 0.25 NEAR.
    let keys = env.w.view_access_keys(agent.id()).await?;
    assert_eq!(keys.len(), 1);
    match &keys[0].access_key.permission {
        AccessKeyPermission::FunctionCall(p) => {
            assert_eq!(p.receiver_id, env.osd.id().as_str());
            assert_eq!(p.method_names, vec!["commit".to_string(), "claim".to_string()]);
            assert_eq!(p.allowance, Some(NearToken::from_millinear(250)));
        }
        AccessKeyPermission::FullAccess => panic!("agent must not have a full-access key"),
    }
    let bal = env.w.view_account(agent.id()).await?.balance;
    assert!(bal >= NearToken::from_millinear(199), "agent funded with 0.2 NEAR, got {bal}");

    // Transfer refused.
    assert!(refused(agent.transfer_near(alice.id(), NearToken::from_millinear(100)).await));
    // Other contract methods refused (also with a deposit).
    for (method, args) in [
        ("fund_agent", json!({"agent_id": agent.id()})),
        ("withdraw", json!({"agent_id": agent.id(), "amount_yocto": "1"})),
        ("close_commits", json!({"season_id": 1})),
        ("play_match", json!({"season_id": 1, "a": agent.id(), "b": alice.id()})),
    ] {
        assert!(refused(agent.call(env.osd.id(), method).args_json(args).max_gas().transact().await), "{method}");
    }
    assert!(refused(
        agent.call(env.osd.id(), "commit").args_json(json!({})).deposit(NearToken::from_yoctonear(1)).transact().await
    ));
    // Other receivers refused.
    assert!(refused(
        agent.call(env.mock.id(), "set_output").args_json(json!({"key": "k", "output": "{}"})).transact().await
    ));
    // Cannot add a full-access key or delete the account.
    let sk = SecretKey::from_random(KeyType::ED25519);
    assert!(refused(agent.batch(agent.id()).add_key(sk.public_key(), AccessKey::full_access()).transact().await));
    assert!(refused(agent.batch(agent.id()).delete_account(alice.id()).transact().await));
    // The agent account cannot withdraw via the owner path either (owner only).
    let r = alice.call(env.osd.id(), "withdraw").args_json(json!({"agent_id": agent.id(), "amount_yocto": "1"})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?;
    assert!(r.is_success());
    let bob = sub(&root, "bob", 5).await?;
    let r = bob.call(env.osd.id(), "withdraw").args_json(json!({"agent_id": agent.id(), "amount_yocto": "1"})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?;
    assert!(r.is_failure() && err_text(&r).contains("not owner"));

    // Allowed method goes through to the contract (fails on contract logic, not on the key).
    let r = agent.call(env.osd.id(), "claim").args_json(json!({"season_id": 1, "agent_id": agent.id()})).gas(Gas::from_tgas(30)).transact().await?;
    assert!(r.is_failure() && err_text(&r).contains("nothing claimable"), "{}", err_text(&r));

    // Name already taken: second registration refused.
    let r = bob
        .call(env.osd.id(), "register_agent")
        .args_json(json!({"name": "tft", "agent_public_key": sk.public_key().to_string()}))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?;
    assert!(r.is_failure() && err_text(&r).contains("name taken"));
    Ok(())
}

/// 05c: a `request_execution` signed directly with the contract account's key (predecessor = contract).
async fn outlayer_as_contract(env: &Env) -> Result<ExecutionFinalResult, near_workspaces::error::Error> {
    let me = env.osd.as_account();
    me.call(env.mock.id(), "request_execution")
        .args_json(json!({
            "source": {"WasmUrl": {"url": "https://test.fastfs.io/osd/referee.wasm", "hash": "ab".repeat(32), "build_target": "wasm32-wasip2"}},
            "resource_limits": {}, "input_data": json!({"action": "derive_pubkey", "season": 1}).to_string(),
            "secrets_ref": {"profile": "osd-test", "account_id": env.admin.id()}, "response_format": "Json",
            "payer_account_id": me.id(),
        }))
        .deposit(NearToken::from_millinear(20))
        .max_gas()
        .transact()
        .await
}

/// F1: the contract account's own full-access key passes `#[private]`. Before and after `seal`
/// direct callbacks are refused ("not a callback"); `seal` deletes every key, so nothing can be
/// signed as the contract (no OutLayer keystore bypass, no redeploy), and seasons still run.
#[tokio::test]
async fn seal_deletes_keys_and_locks_contract() -> anyhow::Result<()> {
    let env = setup().await?;
    let root = env.w.root_account()?;
    let alice = sub(&root, "alice", 20).await?;
    let bob = sub(&root, "bob", 20).await?;
    let a1 = env.register(&alice, "a1", 2).await?;
    let b1 = env.register(&bob, "b1", 2).await?;
    let me = env.osd.as_account(); // signs with the contract account's own full-access key

    // Before seal: direct callbacks from the contract's own key are refused.
    let (sid0, _) = env.open_season(120).await?;
    for (method, args) in [
        ("on_match", json!({"season_id": sid0, "a": a1.id(), "b": b1.id()})),
        ("on_pubkey", json!({"season_id": sid0})),
        ("on_agent_created", json!({"agent_id": format!("zz.{}", env.osd.id()), "owner": me.id(), "name": "zz", "deposit": "100000000000000000000000000"})),
        ("on_sealed", json!({"public_keys": []})),
    ] {
        let r = me.call(env.osd.id(), method).args_json(args).max_gas().transact().await?;
        assert!(r.is_failure() && err_text(&r).contains("not a callback"), "{method}: {}", err_text(&r));
    }
    assert!(!env.view("is_sealed", json!({})).await?.as_bool().unwrap());
    // ...but the key can still call OutLayer with the contract as predecessor (05c, the keystore bypass).
    let r = outlayer_as_contract(&env).await?;
    assert!(r.is_success(), "{}", err_text(&r));
    let req: Value = serde_json::from_str(&env.mock.view("get_last_request").await?.json::<Option<String>>()?.unwrap())?;
    assert_eq!(req["predecessor"], env.osd.id().as_str());

    let keys: Vec<String> = env.w.view_access_keys(env.osd.id()).await?.iter().map(|k| k.public_key.to_string()).collect();
    assert!(!keys.is_empty());
    let seal = |who: &Account, keys: Value, confirm: &str, yocto: u128| {
        who.call(env.osd.id(), "seal")
            .args_json(json!({"public_keys": keys, "confirm": confirm}))
            .deposit(NearToken::from_yoctonear(yocto))
            .max_gas()
            .transact()
    };
    // Refusals: not owner, wrong confirm, no 1 yocto.
    let r = seal(&env.keeper, json!(keys), "SEAL-FOREVER", 1).await?;
    assert!(r.is_failure() && err_text(&r).contains("owner only"));
    let r = seal(&env.admin, json!(keys), "yes", 1).await?;
    assert!(r.is_failure() && err_text(&r).contains("confirm must be"));
    let r = seal(&env.admin, json!(keys), "SEAL-FOREVER", 0).await?;
    assert!(r.is_failure());
    // A key that does not exist: the batch fails, nothing is deleted, not sealed.
    let bogus = SecretKey::from_random(KeyType::ED25519).public_key().to_string();
    let mut with_bogus = keys.clone();
    with_bogus.push(bogus);
    let r = seal(&env.admin, json!(with_bogus), "SEAL-FOREVER", 1).await?;
    assert!(!r.json::<bool>()?);
    assert!(!env.view("is_sealed", json!({})).await?.as_bool().unwrap());
    assert_eq!(env.w.view_access_keys(env.osd.id()).await?.len(), keys.len());

    // Seal (anytime, here while season 1 is in commit).
    let r = seal(&env.admin, json!(keys), "SEAL-FOREVER", 1).await?;
    assert!(r.is_success(), "{}", err_text(&r));
    assert!(r.logs().iter().any(|l| l.contains("\"event\":\"contract_sealed\"")), "{:?}", r.logs());
    assert!(r.json::<bool>()?);
    assert!(env.view("is_sealed", json!({})).await?.as_bool().unwrap());
    assert!(env.w.view_access_keys(env.osd.id()).await?.is_empty(), "view_access_key_list must be []");

    // Irreversible.
    let r = seal(&env.admin, json!([]), "SEAL-FOREVER", 1).await?;
    assert!(r.is_failure() && err_text(&r).contains("already sealed"));
    // Nothing can be signed as the contract any more: no direct callback, no OutLayer call with
    // the contract as predecessor (05c), no redeploy, no new key.
    assert!(refused(me.call(env.osd.id(), "on_match").args_json(json!({"season_id": sid0, "a": a1.id(), "b": b1.id()})).max_gas().transact().await));
    assert!(refused(outlayer_as_contract(&env).await));
    assert!(me.deploy(&wasms().1).await.map_or(true, |r| r.is_failure()), "redeploy must be impossible");
    let sk = SecretKey::from_random(KeyType::ED25519);
    assert!(refused(me.batch(env.osd.id()).add_key(sk.public_key(), AccessKey::full_access()).transact().await));

    // Season 1 (opened before seal) still runs to settlement; then season 2 uses the config referee only.
    for (ag, i) in [(&a1, 0), (&b1, 2)] {
        let e = &fx("entries.json")[i];
        let r = ag
            .call(env.osd.id(), "commit")
            .args_json(json!({"season_id": sid0, "agent_id": ag.id(), "ciphertext_hex": e["ciphertext_hex"],
                              "commitment": e["commitment"], "family": e["family"], "parent": null}))
            .gas(Gas::from_tgas(50))
            .transact()
            .await?;
        assert!(r.is_success(), "{}", err_text(&r));
    }
    let deadline: u64 = env.view("get_season", json!({"season_id": sid0})).await?["params"]["commit_deadline_ns"].as_str().unwrap().parse()?;
    env.wait_past(deadline).await?;
    env.keeper.call(env.osd.id(), "close_commits").args_json(json!({"season_id": sid0})).max_gas().transact().await?.into_result()?;
    env.keeper.call(env.osd.id(), "schedule_round").args_json(json!({"season_id": sid0})).max_gas().transact().await?.into_result()?;
    let (a, b) = ordered(a1.id(), b1.id());
    let mk = format!("{sid0}:{a}:{b}");
    let (ma, mb) = if a == a1.id() { ("D", "C") } else { ("C", "D") };
    env.mock.call("set_output").args_json(json!({"key": mk, "output": out(&mk, ma, mb)})).transact().await?.into_result()?;
    let r = env
        .keeper
        .call(env.osd.id(), "play_match")
        .args_json(json!({"season_id": sid0, "a": a, "b": b}))
        .deposit(NearToken::from_millinear(20))
        .max_gas()
        .transact()
        .await?;
    assert!(r.clone().json::<String>()?.starts_with("settled "), "{}", err_text(&r));
    let rows: Vec<Value> = env.keeper.call(env.osd.id(), "settle_season").args_json(json!({"season_id": sid0})).max_gas().transact().await?.into_result()?.json()?;
    assert_eq!(rows[0]["agent_id"], a1.id().as_str());
    assert_eq!(rows[0]["rank"], 1);

    // Overrides refused after seal; the config default still opens a season.
    let mut params = fx("season.json")["params"].clone();
    let dl = env.now_ns().await? + 600 * 1_000_000_000;
    params["commit_deadline_ns"] = json!(dl.to_string());
    params["play_deadline_ns"] = json!((dl + 3_600 * 1_000_000_000).to_string());
    for ov in [
        json!({"wasm_url": "https://evil/probe.wasm", "wasm_hash": "ee".repeat(32)}),
        json!({"secrets_profile": "other"}),
    ] {
        let mut args = ov.clone();
        args["params"] = params.clone();
        let r = env.admin.call(env.osd.id(), "open_season").args_json(args).deposit(NearToken::from_millinear(20)).max_gas().transact().await?;
        assert!(r.is_failure() && err_text(&r).contains("sealed: per-season"), "{}", err_text(&r));
    }
    let (sid1, _) = env.open_season(600).await?;
    assert_eq!(sid1, sid0 + 1);
    let s = env.view("get_season", json!({"season_id": sid1})).await?;
    assert_eq!(s["secrets_profile"], "osd-test");
    Ok(())
}

/// Worst-case gas at the 40-agent cap: 20-match rounds, then settle_season voiding all
/// 780 matches at the play deadline. Slow (~minutes); run with `cargo test -- --ignored`.
#[tokio::test]
#[ignore]
async fn gas_at_max_agents() -> anyhow::Result<()> {
    let env = setup().await?;
    let root = env.w.root_account()?;
    let mut owners = vec![];
    for i in 0..8 {
        owners.push(sub(&root, &format!("own{i}"), 20).await?);
    }
    let mut agents = vec![];
    for i in 0..40 {
        agents.push(env.register(&owners[i % 8], &format!("ag{i:02}"), 2).await?);
    }
    let (sid, deadline) = env.open_season_with(120, 60, 40, 5).await?;
    let ct = "ab".repeat(4200); // max-size ciphertext
    for ag in &agents {
        let r = ag
            .call(env.osd.id(), "commit")
            .args_json(json!({"season_id": sid, "agent_id": ag.id(), "ciphertext_hex": ct,
                              "commitment": "cd".repeat(32), "family": "f", "parent": null}))
            .gas(Gas::from_tgas(50))
            .transact()
            .await?;
        record_gas("commit(8400hex)", &r);
        assert!(r.is_success(), "{}", err_text(&r));
    }
    env.wait_past(deadline).await?;
    let r = env.keeper.call(env.osd.id(), "close_commits").args_json(json!({"season_id": sid})).max_gas().transact().await?;
    record_gas("close_commits", &r);
    r.into_result()?;
    for _ in 0..39 {
        let r = env.keeper.call(env.osd.id(), "schedule_round").args_json(json!({"season_id": sid})).max_gas().transact().await?;
        record_gas("schedule_round", &r);
        assert_eq!(r.into_result()?.json::<Vec<Value>>()?.len(), 20);
    }
    let play_deadline = deadline + 60_000_000_000;
    env.wait_past(play_deadline).await?;
    // Voids are batched (log limit): call until the ranking comes back.
    let mut calls = 0;
    loop {
        let r = env.keeper.call(env.osd.id(), "settle_season").args_json(json!({"season_id": sid})).max_gas().transact().await?;
        record_gas("settle_season", &r);
        assert!(r.is_success(), "{}", err_text(&r));
        calls += 1;
        if !r.json::<Vec<Value>>()?.is_empty() {
            break;
        }
        assert!(calls < 30);
    }
    println!("settle_season calls at deadline with 780 unfinished matches: {calls}");
    let rows = env.view("get_leaderboard", json!({"season_id": sid})).await?;
    assert_eq!(rows.as_array().unwrap().len(), 40);
    let m = env.view("get_matches", json!({"season_id": sid, "status": "refunded", "limit": 200})).await?;
    assert_eq!(m.as_array().unwrap().len(), 200);
    let g = gas_log().lock().unwrap();
    println!("GAS @40 agents (Tgas burnt, max per call):");
    for (k, v) in g.iter() {
        println!("  {k:16} {:.2}", *v as f64 / 1e12);
    }
    Ok(())
}
