use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken};

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("cards.osd.testnet"))
        .predecessor_account_id(acc(predecessor))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(1_000);
    testing_env!(b.build());
}

fn setup() -> Cards {
    ctx("keeper.testnet", 0);
    Cards::new(acc("keeper.testnet"), acc("osd.testnet"))
}

fn row(agent: &str, owner: &str, rank: u32, parent: Option<(u32, &str)>) -> CardInput {
    CardInput {
        agent_id: acc(agent),
        owner: acc(owner),
        family: "nice".into(),
        rank: Some(rank),
        avg_payoff_milli: Some(2555),
        commitment: "ab".repeat(32),
        parent: parent.map(|(s, a)| ParentRef { season_id: s, agent_id: acc(a) }),
    }
}

fn events(event: &str) -> Vec<serde_json::Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<serde_json::Value>(j).unwrap())
        .filter(|v| v["event"] == event)
        .collect()
}

fn season1(c: &mut Cards) -> Vec<TokenId> {
    ctx("keeper.testnet", 0);
    c.mint_season_cards(
        1,
        vec![row("a.osd.testnet", "alice.testnet", 1, None), row("b.osd.testnet", "bob.testnet", 2, None), row("c.osd.testnet", "alice.testnet", 3, None)],
        Some("7ARhgA7Fnt6QP71B6CwUFXEYPiVTV1sc7E1frRZj3ACn".into()),
    )
}

#[test]
fn token_ids() {
    assert_eq!(card_token_id(3, &acc("a.osd.testnet")), "s3:a.osd.testnet");
    assert_eq!(badge_token_id(3), "badge:s3");
}

#[test]
#[should_panic(expected = "only the owner can mint")]
fn mint_requires_owner() {
    let mut c = setup();
    ctx("mallory.testnet", 0);
    c.mint_season_cards(1, vec![row("a.osd.testnet", "alice.testnet", 1, None)], None);
}

#[test]
#[should_panic(expected = "already minted")]
fn mint_twice_panics() {
    let mut c = setup();
    season1(&mut c);
    season1(&mut c);
}

#[test]
fn mint_cards_and_badges() {
    let mut c = setup();
    let ids = season1(&mut c);
    assert_eq!(ids, vec!["s1:a.osd.testnet", "s1:b.osd.testnet", "s1:c.osd.testnet"]);
    let alice = acc("alice.testnet");
    assert_eq!(c.mt_balance_of(alice.clone(), "s1:a.osd.testnet".into()), U128(1));
    assert_eq!(c.mt_balance_of(alice.clone(), "s1:b.osd.testnet".into()), U128(0));
    assert_eq!(c.mt_balance_of(alice.clone(), "badge:s1".into()), U128(2));
    assert_eq!(c.mt_balance_of(acc("bob.testnet"), "badge:s1".into()), U128(1));
    assert_eq!(c.mt_supply("badge:s1".into()), Some(U128(3)));
    assert_eq!(c.mt_supply("s1:a.osd.testnet".into()), Some(U128(1)));
    assert_eq!(c.mt_supply("nope".into()), None);

    let t = c.mt_token(vec!["s1:a.osd.testnet".into(), "missing".into()]);
    let card = t[0].clone().unwrap();
    assert!(t[1].is_none());
    assert_eq!(card.owner_id, Some(alice.clone()));
    assert_eq!(card.metadata.kind, TokenKind::Card);
    assert_eq!(card.metadata.rank, Some(1));
    assert_eq!(card.metadata.family.as_deref(), Some("nice"));
    assert_eq!(card.metadata.core_contract, acc("osd.testnet"));
    assert_eq!(card.metadata.settle_tx.as_deref(), Some("7ARhgA7Fnt6QP71B6CwUFXEYPiVTV1sc7E1frRZj3ACn"));
    assert_eq!(card.metadata.parent_card, None);
    let badge = c.mt_token(vec!["badge:s1".into()])[0].clone().unwrap();
    assert_eq!(badge.owner_id, None);
    assert_eq!(badge.metadata.kind, TokenKind::Badge);

    // one mt_mint event, one data entry per owner, badge amounts aggregated
    let ev = events("mt_mint");
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["standard"], "nep245");
    assert_eq!(ev[0]["version"], "1.0.0");
    let data = ev[0]["data"].as_array().unwrap();
    assert_eq!(data.len(), 2);
    assert_eq!(data[0]["owner_id"], "alice.testnet");
    assert_eq!(data[0]["token_ids"], json!(["s1:a.osd.testnet", "badge:s1", "s1:c.osd.testnet"]));
    assert_eq!(data[0]["amounts"], json!(["1", "2", "1"]));

    assert_eq!(c.mt_tokens(None, None).len(), 4);
    assert_eq!(c.mt_tokens_for_owner(alice, None, None).len(), 3);
    assert_eq!(c.get_config().n_tokens, 4);
}

#[test]
fn parent_card_links_when_parent_was_carded() {
    let mut c = setup();
    season1(&mut c);
    ctx("keeper.testnet", 0);
    c.mint_season_cards(
        2,
        vec![
            row("d.osd.testnet", "dan.testnet", 1, Some((1, "a.osd.testnet"))),
            row("e.osd.testnet", "dan.testnet", 2, Some((1, "zzz.osd.testnet"))),
            row("a.osd.testnet", "alice.testnet", 3, None),
        ],
        None,
    );
    let t = c.mt_token(vec!["s2:d.osd.testnet".into(), "s2:e.osd.testnet".into()]);
    assert_eq!(t[0].clone().unwrap().metadata.parent_card.as_deref(), Some("s1:a.osd.testnet"));
    assert_eq!(t[1].clone().unwrap().metadata.parent_card, None);
    let a_cards: Vec<_> = c.cards_for_agent(acc("a.osd.testnet")).into_iter().map(|t| t.token_id).collect();
    assert_eq!(a_cards, vec!["s1:a.osd.testnet", "s2:a.osd.testnet"]);
    assert_eq!(c.mt_supply("badge:s2".into()), Some(U128(3)));
}

#[test]
#[should_panic(expected = "parent must be from an earlier season")]
fn parent_from_same_season_rejected() {
    let mut c = setup();
    ctx("keeper.testnet", 0);
    c.mint_season_cards(1, vec![row("d.osd.testnet", "dan.testnet", 1, Some((1, "a.osd.testnet")))], None);
}

#[test]
fn transfer_moves_card_and_owner() {
    let mut c = setup();
    season1(&mut c);
    ctx("alice.testnet", 1);
    c.mt_transfer(acc("carol.testnet"), "s1:a.osd.testnet".into(), U128(1), None, Some("gift".into()));
    assert_eq!(c.mt_balance_of(acc("alice.testnet"), "s1:a.osd.testnet".into()), U128(0));
    assert_eq!(c.mt_balance_of(acc("carol.testnet"), "s1:a.osd.testnet".into()), U128(1));
    assert_eq!(c.mt_token(vec!["s1:a.osd.testnet".into()])[0].clone().unwrap().owner_id, Some(acc("carol.testnet")));
    let ev = events("mt_transfer");
    assert_eq!(ev.len(), 1);
    assert_eq!(
        ev[0]["data"],
        json!([{"old_owner_id": "alice.testnet", "new_owner_id": "carol.testnet", "token_ids": ["s1:a.osd.testnet"], "amounts": ["1"], "memo": "gift"}])
    );
    assert_eq!(c.mt_tokens_for_owner(acc("alice.testnet"), None, None).len(), 2);
}

#[test]
fn batch_transfer_partial_badge() {
    let mut c = setup();
    season1(&mut c);
    ctx("alice.testnet", 1);
    c.mt_batch_transfer(acc("bob.testnet"), vec!["badge:s1".into(), "s1:c.osd.testnet".into()], vec![U128(1), U128(1)], None, None);
    assert_eq!(
        c.mt_batch_balance_of(acc("alice.testnet"), vec!["badge:s1".into(), "s1:c.osd.testnet".into()]),
        vec![U128(1), U128(0)]
    );
    assert_eq!(c.mt_balance_of(acc("bob.testnet"), "badge:s1".into()), U128(2));
    assert_eq!(c.mt_supply("badge:s1".into()), Some(U128(3)));
    // badges have no single owner
    assert_eq!(c.mt_token(vec!["badge:s1".into()])[0].clone().unwrap().owner_id, None);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn transfer_requires_one_yocto() {
    let mut c = setup();
    season1(&mut c);
    ctx("alice.testnet", 0);
    c.mt_transfer(acc("carol.testnet"), "s1:a.osd.testnet".into(), U128(1), None, None);
}

#[test]
#[should_panic(expected = "insufficient balance")]
fn transfer_without_balance_panics() {
    let mut c = setup();
    season1(&mut c);
    ctx("bob.testnet", 1);
    c.mt_transfer(acc("carol.testnet"), "s1:a.osd.testnet".into(), U128(1), None, None);
}

#[test]
#[should_panic(expected = "approvals are not supported")]
fn approvals_rejected() {
    let mut c = setup();
    season1(&mut c);
    ctx("alice.testnet", 1);
    c.mt_transfer(acc("carol.testnet"), "s1:a.osd.testnet".into(), U128(1), Some((acc("x.testnet"), 1)), None);
}

#[test]
fn resolve_transfer_refunds_unused() {
    let mut c = setup();
    season1(&mut c);
    ctx("alice.testnet", 1);
    c.mt_batch_transfer(acc("recv.testnet"), vec!["badge:s1".into(), "s1:a.osd.testnet".into()], vec![U128(2), U128(1)], None, None);
    // receiver keeps the card, returns 1 badge
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("cards.osd.testnet")).predecessor_account_id(acc("cards.osd.testnet"));
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(serde_json::to_vec(&vec![U128(1), U128(0)]).unwrap())],
    );
    let used = c.mt_resolve_transfer(
        vec![acc("alice.testnet"), acc("alice.testnet")],
        acc("recv.testnet"),
        vec!["badge:s1".into(), "s1:a.osd.testnet".into()],
        vec![U128(2), U128(1)],
        None,
    );
    assert_eq!(used, vec![U128(1), U128(1)]);
    assert_eq!(c.mt_balance_of(acc("alice.testnet"), "badge:s1".into()), U128(1));
    assert_eq!(c.mt_balance_of(acc("recv.testnet"), "s1:a.osd.testnet".into()), U128(1));
    assert_eq!(events("mt_transfer").len(), 1);
}
