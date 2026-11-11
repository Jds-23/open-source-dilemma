//! near-workspaces sandbox tests for the cards contract: mint authz, NEP-245 transfers, balances,
//! events and parent_card linking. The wasm is built with plain `cargo` (`-C target-cpu=mvp`) and
//! re-encoded with `walrus` so the sandbox (nearcore 2.6) accepts rustc 1.85 output, as in
//! contracts/dilemma. Real deploys use `cargo near build` (ops/scripts/deploy-cards.sh).
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

const SANDBOX_VERSION: &str = "2.6.5";

fn wasm() -> &'static Vec<u8> {
    static W: OnceLock<Vec<u8>> = OnceLock::new();
    W.get_or_init(|| {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let target_dir = root.join("target/wasm-it");
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let status = Command::new(cargo)
            .current_dir(root)
            .args(["build", "--locked", "--release", "--target", "wasm32-unknown-unknown", "--lib", "--target-dir"])
            .arg(&target_dir)
            .env("RUSTFLAGS", "-C link-arg=-s -C target-cpu=mvp")
            .env_remove("CARGO_ENCODED_RUSTFLAGS")
            .env_remove("CARGO_TARGET_DIR")
            .status()
            .expect("spawn cargo");
        assert!(status.success(), "wasm build failed");
        let path: PathBuf = target_dir.join("wasm32-unknown-unknown/release/cards_contract.wasm");
        walrus::Module::from_file(&path).expect("parse wasm").emit_wasm()
    })
}

struct Env {
    w: Worker<Sandbox>,
    keeper: Account,
    alice: Account,
    bob: Account,
    cards: Contract,
}

async fn sub(root: &Account, name: &str, near: u128) -> anyhow::Result<Account> {
    Ok(root.create_subaccount(name).initial_balance(NearToken::from_near(near)).transact().await?.into_result()?)
}

async fn setup() -> anyhow::Result<Env> {
    let w = near_workspaces::sandbox_with_version(SANDBOX_VERSION).await?;
    let root = w.root_account()?;
    let keeper = sub(&root, "keeper", 10).await?;
    let alice = sub(&root, "alice", 10).await?;
    let bob = sub(&root, "bob", 10).await?;
    let cards = sub(&root, "cards", 10).await?.deploy(wasm()).await?.into_result()?;
    cards
        .call("new")
        .args_json(json!({"owner_id": keeper.id(), "core_contract": "osd.test.near"}))
        .transact()
        .await?
        .into_result()?;
    Ok(Env { w, keeper, alice, bob, cards })
}

fn events(r: &ExecutionFinalResult, event: &str) -> Vec<Value> {
    r.logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<Value>(j).unwrap())
        .filter(|v| v["event"] == event && v["standard"] == "nep245" && v["version"] == "1.0.0")
        .collect()
}

fn row(agent: &str, owner: &Account, rank: u32, parent: Option<(u32, &str)>) -> Value {
    json!({
        "agent_id": agent,
        "owner": owner.id(),
        "family": "nice",
        "rank": rank,
        "avg_payoff_milli": 2000 + rank,
        "commitment": "cd".repeat(32),
        "parent": parent.map(|(s, a)| json!({"season_id": s, "agent_id": a})),
    })
}

impl Env {
    async fn view(&self, method: &str, args: Value) -> anyhow::Result<Value> {
        Ok(self.cards.view(method).args_json(args).await?.json()?)
    }
    async fn balance(&self, who: &Account, token: &str) -> anyhow::Result<String> {
        Ok(self.view("mt_balance_of", json!({"account_id": who.id(), "token_id": token})).await?.as_str().unwrap().to_string())
    }
    async fn mint(&self, signer: &Account, season: u32, rows: Vec<Value>) -> anyhow::Result<ExecutionFinalResult> {
        Ok(signer
            .call(self.cards.id(), "mint_season_cards")
            .args_json(json!({"season_id": season, "cards": rows, "settle_tx": "7ARhgA7Fnt6QP71B6CwUFXEYPiVTV1sc7E1frRZj3ACn"}))
            .max_gas()
            .transact()
            .await?)
    }
}

#[tokio::test]
async fn cards_flow() -> anyhow::Result<()> {
    let e = setup().await?;

    // --- mint authz: only the owner (keeper) can mint
    let r = e.mint(&e.alice, 1, vec![row("a.osd.test.near", &e.alice, 1, None)]).await?;
    assert!(r.is_failure());
    assert!(format!("{:?}", r.into_result().unwrap_err()).contains("only the owner can mint"));

    // --- season 1: alice has two entries, bob one
    let s1 = vec![
        row("a.osd.test.near", &e.alice, 1, None),
        row("b.osd.test.near", &e.bob, 2, None),
        row("c.osd.test.near", &e.alice, 3, None),
    ];
    let r = e.mint(&e.keeper, 1, s1.clone()).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let ev = events(&r, "mt_mint");
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["data"][0]["owner_id"], e.alice.id().as_str());
    assert_eq!(ev[0]["data"][0]["amounts"], json!(["1", "2", "1"]));
    assert_eq!(r.json::<Vec<String>>()?, vec!["s1:a.osd.test.near", "s1:b.osd.test.near", "s1:c.osd.test.near"]);
    // re-minting the same season row panics
    assert!(e.mint(&e.keeper, 1, vec![s1[0].clone()]).await?.is_failure());

    assert_eq!(e.balance(&e.alice, "s1:a.osd.test.near").await?, "1");
    assert_eq!(e.balance(&e.alice, "badge:s1").await?, "2");
    assert_eq!(e.balance(&e.bob, "badge:s1").await?, "1");
    assert_eq!(e.view("mt_supply", json!({"token_id": "badge:s1"})).await?, json!("3"));
    let t = e.view("mt_token", json!({"token_ids": ["s1:a.osd.test.near", "nope"]})).await?;
    assert_eq!(t[0]["owner_id"], e.alice.id().as_str());
    assert_eq!(t[0]["metadata"]["kind"], "card");
    assert_eq!(t[0]["metadata"]["rank"], 1);
    assert_eq!(t[0]["metadata"]["core_contract"], "osd.test.near");
    assert_eq!(t[0]["metadata"]["parent_card"], Value::Null);
    assert_eq!(t[1], Value::Null);

    // --- parent_card linking (season 2 child of s1 card; unknown parent stays null)
    let r = e
        .mint(
            &e.keeper,
            2,
            vec![row("d.osd.test.near", &e.bob, 1, Some((1, "a.osd.test.near"))), row("x.osd.test.near", &e.bob, 2, Some((1, "gone.test.near")))],
        )
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let t = e.view("mt_token", json!({"token_ids": ["s2:d.osd.test.near", "s2:x.osd.test.near"]})).await?;
    assert_eq!(t[0]["metadata"]["parent_card"], "s1:a.osd.test.near");
    assert_eq!(t[1]["metadata"]["parent_card"], Value::Null);

    // --- mt_transfer: 1 yocto required
    let no_yocto = e
        .alice
        .call(e.cards.id(), "mt_transfer")
        .args_json(json!({"receiver_id": e.bob.id(), "token_id": "s1:a.osd.test.near", "amount": "1"}))
        .transact()
        .await?;
    assert!(no_yocto.is_failure());
    let r = e
        .alice
        .call(e.cards.id(), "mt_transfer")
        .args_json(json!({"receiver_id": e.bob.id(), "token_id": "s1:a.osd.test.near", "amount": "1", "memo": "gg"}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let ev = events(&r, "mt_transfer");
    assert_eq!(
        ev[0]["data"],
        json!([{"old_owner_id": e.alice.id(), "new_owner_id": e.bob.id(), "token_ids": ["s1:a.osd.test.near"], "amounts": ["1"], "memo": "gg"}])
    );
    assert_eq!(e.balance(&e.alice, "s1:a.osd.test.near").await?, "0");
    assert_eq!(e.balance(&e.bob, "s1:a.osd.test.near").await?, "1");
    let t = e.view("mt_token", json!({"token_ids": ["s1:a.osd.test.near"]})).await?;
    assert_eq!(t[0]["owner_id"], e.bob.id().as_str());

    // --- batch transfer, then over-spend fails atomically
    let r = e
        .alice
        .call(e.cards.id(), "mt_batch_transfer")
        .args_json(json!({"receiver_id": e.bob.id(), "token_ids": ["badge:s1", "s1:c.osd.test.near"], "amounts": ["1", "1"]}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(
        e.view("mt_batch_balance_of", json!({"account_id": e.bob.id(), "token_ids": ["badge:s1", "s1:c.osd.test.near", "s2:d.osd.test.near"]})).await?,
        json!(["2", "1", "1"])
    );
    let r = e
        .alice
        .call(e.cards.id(), "mt_batch_transfer")
        .args_json(json!({"receiver_id": e.bob.id(), "token_ids": ["badge:s1", "s1:b.osd.test.near"], "amounts": ["1", "1"]}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(r.is_failure());
    assert_eq!(e.balance(&e.alice, "badge:s1").await?, "1");

    // --- mt_transfer_call to an account without code: receiver fails, resolve refunds
    let r = e
        .bob
        .call(e.cards.id(), "mt_transfer_call")
        .args_json(json!({"receiver_id": e.alice.id(), "token_id": "badge:s1", "amount": "2", "msg": ""}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert_eq!(r.clone().json::<Vec<String>>()?, vec!["0"]);
    assert_eq!(events(&r, "mt_transfer").len(), 2);
    assert_eq!(e.balance(&e.bob, "badge:s1").await?, "2");
    assert_eq!(e.balance(&e.alice, "badge:s1").await?, "1");

    let cards = e.view("cards_for_agent", json!({"agent_id": "a.osd.test.near"})).await?;
    assert_eq!(cards.as_array().unwrap().len(), 1);
    assert_eq!(e.view("get_config", json!({})).await?["n_tokens"], 7);
    Ok(())
}

/// F1 for the cards account: direct `mt_resolve_transfer` from its own key is refused; `seal`
/// deletes every key (view_access_key_list → []), is one way, and minting stays owner-only.
#[tokio::test]
async fn seal_deletes_keys() -> anyhow::Result<()> {
    let e = setup().await?;
    let me = e.cards.as_account();
    e.mint(&e.keeper, 1, vec![row("a.osd.test.near", &e.alice, 1, None)]).await?.into_result()?;
    let r = me
        .call(e.cards.id(), "mt_resolve_transfer")
        .args_json(json!({"previous_owner_ids": [e.alice.id()], "receiver_id": e.bob.id(), "token_ids": ["badge:s1"], "amounts": ["1"]}))
        .max_gas()
        .transact()
        .await?;
    assert!(r.is_failure() && format!("{:?}", r.failures()).contains("not a callback"));

    let keys: Vec<String> = e.w.view_access_keys(e.cards.id()).await?.iter().map(|k| k.public_key.to_string()).collect();
    assert!(!keys.is_empty());
    let seal = |who: &Account, keys: Value| {
        who.call(e.cards.id(), "seal")
            .args_json(json!({"public_keys": keys, "confirm": "SEAL-FOREVER"}))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
    };
    let r = seal(&e.alice, json!(keys)).await?;
    assert!(r.is_failure() && format!("{:?}", r.failures()).contains("owner only"));
    let r = seal(&e.keeper, json!(keys)).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert!(r.logs().iter().any(|l| l.contains("\"event\":\"contract_sealed\"")));
    assert_eq!(e.view("is_sealed", json!({})).await?, json!(true));
    assert!(e.w.view_access_keys(e.cards.id()).await?.is_empty());
    let r = seal(&e.keeper, json!([])).await?;
    assert!(r.is_failure() && format!("{:?}", r.failures()).contains("already sealed"));
    assert!(me.deploy(wasm()).await.map_or(true, |r| r.is_failure()));
    // minting continues (owner only)
    assert!(e.mint(&e.keeper, 2, vec![row("a.osd.test.near", &e.alice, 1, None)]).await?.is_success());
    assert!(e.mint(&e.alice, 3, vec![row("a.osd.test.near", &e.alice, 1, None)]).await?.is_failure());
    Ok(())
}
