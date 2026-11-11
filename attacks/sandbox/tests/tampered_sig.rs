//! Attack 6: tampered NEAR AI signature (sandbox evidence).
//!
//! Live OutLayer output can't be edited, so this runs the real dilemma contract against the
//! contract's own mock OutLayer (`contracts/dilemma/tests/mock-outlayer`) in a near-workspaces
//! sandbox. The mock returns referee outputs whose proof fields we tamper with. Expected: the
//! signature flags are false and the match still settles with the referee's moves (flag only,
//! INTERFACE.md §7). Each case prints one `ATTACK_RESULT {json}` line for the TS wrapper.
use near_workspaces::network::Sandbox;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

const SANDBOX_VERSION: &str = "2.6.5";

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

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
    let path = target_dir.join("wasm32-unknown-unknown/release").join(artifact);
    walrus::Module::from_file(&path).expect("parse wasm").emit_wasm()
}

fn fx(name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(repo().join("interfaces/fixtures").join(name)).unwrap()).unwrap()
}

async fn sub(root: &Account, name: &str, near: u128) -> anyhow::Result<Account> {
    Ok(root.create_subaccount(name).initial_balance(NearToken::from_near(near)).transact().await?.into_result()?)
}

fn flip_last_hex(s: &str) -> String {
    let mut c: Vec<char> = s.chars().collect();
    let last = c.pop().unwrap();
    c.push(if last == '0' { '1' } else { '0' });
    c.into_iter().collect()
}

fn report(id: &str, title: &str, expected: &str, actual: String, pass: bool, tx: String) {
    println!(
        "ATTACK_RESULT {}",
        json!({"id": id, "title": title, "expected": expected, "actual": actual, "pass": pass, "tx": tx})
    );
}

#[tokio::test]
async fn tampered_nearai_signature_sets_flag_false_and_still_settles() -> anyhow::Result<()> {
    let dilemma = build_wasm(&repo().join("contracts/dilemma"), "dilemma_contract.wasm");
    let mock_wasm = build_wasm(&repo().join("contracts/dilemma/tests/mock-outlayer"), "mock_outlayer.wasm");
    let w: Worker<Sandbox> = near_workspaces::sandbox_with_version(SANDBOX_VERSION).await?;
    let root = w.root_account()?;
    let admin = sub(&root, "admin", 50).await?;
    let keeper = sub(&root, "keeper", 20).await?;
    let mock: Contract = sub(&root, "outlayer", 20).await?.deploy(&mock_wasm).await?.into_result()?;
    mock.call("new").transact().await?.into_result()?;
    let osd: Contract = sub(&root, "osd", 50).await?.deploy(&dilemma).await?.into_result()?;
    let signer_hex = fx("test-nearai-signer.json")["public_key_hex"].clone();
    admin
        .call(osd.id(), "new")
        .args_json(json!({
            "wasm_url": "https://test.fastfs.io/osd/referee.wasm", "wasm_hash": "ab".repeat(32),
            "secrets_owner": admin.id(), "secrets_profile": "osd-test",
            "nearai_signer": signer_hex, "outlayer_account": mock.id(),
        }))
        .transact()
        .await?
        .into_result()?;

    // Season: 3 agents, 3 owners → 3 matches.
    mock.call("set_output")
        .args_json(json!({"key": "derive_pubkey", "output": json!({"pubkey": fx("season.json")["pubkey"]}).to_string()}))
        .transact()
        .await?
        .into_result()?;
    let now = w.view_block().await?.timestamp();
    let mut params = fx("season.json")["params"].clone();
    let deadline = now + 20 * 1_000_000_000;
    params["commit_deadline_ns"] = json!(deadline.to_string());
    params["play_deadline_ns"] = json!((deadline + 3_600 * 1_000_000_000u64).to_string());
    params["max_agents"] = json!(3);
    let sid: u32 = admin
        .call(osd.id(), "open_season")
        .args_json(json!({"params": params}))
        .deposit(NearToken::from_millinear(20))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;

    let entries = fx("entries.json");
    let mut agents: Vec<Account> = vec![];
    for (i, name) in ["ann", "bea", "cid"].iter().enumerate() {
        let owner = sub(&root, &format!("own{i}"), 10).await?;
        let sk = SecretKey::from_random(KeyType::ED25519);
        owner
            .call(osd.id(), "register_agent")
            .args_json(json!({"name": name, "agent_public_key": sk.public_key().to_string()}))
            .deposit(NearToken::from_near(2))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        let id: AccountId = format!("{name}.{}", osd.id()).parse()?;
        let ag = Account::from_secret_key(id, sk, &w);
        ag.call(osd.id(), "commit")
            .args_json(json!({"season_id": sid, "agent_id": ag.id(), "ciphertext_hex": entries[i]["ciphertext_hex"],
                              "commitment": entries[i]["commitment"], "family": "x", "parent": null}))
            .gas(Gas::from_tgas(50))
            .transact()
            .await?
            .into_result()?;
        agents.push(ag);
    }
    while w.view_block().await?.timestamp() <= deadline {
        w.fast_forward(20).await?;
    }
    keeper.call(osd.id(), "close_commits").args_json(json!({"season_id": sid})).max_gas().transact().await?.into_result()?;
    for _ in 0..3 {
        keeper.call(osd.id(), "schedule_round").args_json(json!({"season_id": sid})).max_gas().transact().await?.into_result()?;
    }
    let matches: Vec<Value> = osd.view("get_matches").args_json(json!({"season_id": sid})).await?.json()?;
    assert_eq!(matches.len(), 3);

    // Referee outputs: genuine TEST-ONLY signatures from the fixture, then tampered variants.
    let o = &fx("wasm-outputs.json")[0];
    let s = |k: &str| o[k].as_str().unwrap().to_string();
    let cases: Vec<(&str, &str, &str, &str, Value, (bool, bool))> = vec![
        ("06a", "Control: genuine NEAR AI signatures", "sig_a_ok = sig_b_ok = true; settled", "C",
         json!({"a_signed_text": s("a_signed_text"), "b_signed_text": s("b_signed_text"), "a_sig": s("a_sig"), "b_sig": s("b_sig")}), (true, true)),
        ("06b", "Tampered: a_sig one hex digit flipped; b_signed_text response hash edited", "sig_a_ok = sig_b_ok = false; match still settles with the referee moves", "D",
         json!({"a_signed_text": s("a_signed_text"), "b_signed_text": flip_last_hex(&s("b_signed_text")), "a_sig": flip_last_hex(&s("a_sig")), "b_sig": s("b_sig")}), (false, false)),
        ("06c", "Tampered: signatures swapped between sides; one proof dropped", "sig flags false; settles", "D",
         json!({"a_signed_text": s("a_signed_text"), "a_sig": s("b_sig")}), (false, false)),
    ];
    for ((id, title, expected, a_move, proof, (want_a, want_b)), m) in cases.into_iter().zip(matches.iter()) {
        let mk = m["match_key"].as_str().unwrap();
        let mut out = json!({"match_key": mk, "a_move": a_move, "b_move": "C", "a_chat_id": s("a_chat_id"), "b_chat_id": s("b_chat_id")});
        for (k, v) in proof.as_object().unwrap() {
            out[k] = v.clone();
        }
        mock.call("set_output").args_json(json!({"key": mk, "output": out.to_string()})).transact().await?.into_result()?;
        let r = keeper
            .call(osd.id(), "play_match")
            .args_json(json!({"season_id": sid, "a": m["a"], "b": m["b"]}))
            .deposit(NearToken::from_millinear(20))
            .max_gas()
            .transact()
            .await?;
        let tx = r.outcome().transaction_hash.to_string();
        let ret: String = r.json()?;
        let after: Vec<Value> = osd.view("get_matches").args_json(json!({"season_id": sid})).await?.json()?;
        let am = after.iter().find(|x| x["match_key"] == mk).unwrap();
        let (fa, fb) = (am["sig_a_ok"].as_bool().unwrap(), am["sig_b_ok"].as_bool().unwrap());
        let settled = am["status"] == "settled" && am["a_move"] == a_move && am["b_move"] == "C";
        let ok = settled && fa == want_a && fb == want_b;
        report(
            id,
            title,
            expected,
            format!("play_match → {ret:?}; status {}; moves {}{}; payoffs {}/{}; sig_a_ok={fa} sig_b_ok={fb}",
                    am["status"], am["a_move"], am["b_move"], am["a_payoff"], am["b_payoff"]),
            ok,
            tx,
        );
        assert!(ok, "{id}: {am}");
    }
    Ok(())
}
