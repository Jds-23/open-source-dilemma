# WS-7 attack results

Target: `osd.baldingsucks7993.testnet` (testnet, `interfaces-v4`), referee WASM `ad40dcf4…`, secret profile `osd-ad40dcf455fa`
(`WasmHash(ad40dcf4…)` + `Predecessor{Whitelist[osd.baldingsucks7993.testnet]}`).
Every row below was produced by a script in `attacks/src/attacks/` and is stored with full details in [`results.json`](results.json).

- **testnet** rows are real transactions (links go to nearblocks). Rows rejected by the RPC before inclusion (agent-key misuse) have no tx hash: the validator refuses them, so nothing lands on chain.
- **sandbox** rows (attack 6) come from `attacks/sandbox` (near-workspaces, the real contract against the contract's mock OutLayer), because a live OutLayer output can't be tampered with. Their hashes are sandbox-local.
- **analysis** rows are documented reasoning, no transaction.

## Status

- **No-season attacks** (1, 2, 3, 4, 5, 6, 11, 12 and the season-1 part of 10) run concurrently with `run no-season`
  (last run 2026-11-11: 137 s wall, about 0.013 testnet NEAR net). They only touch the settled season 1.
- **Season attacks** (7 duplicate prompt, 8 commitment mismatch, 9 clone-farm cap, 10 on new seasons, 12 play-phase
  calls, 13 low-gas play) ran against attack **season 4** (opened 2026-11-11 13:14 UTC on the fast-attack timing: commit
  `+165s` from open = ~45 s to `on_pubkey` + a 2 min window, play deadline `+10m`; open tx
  [`Gbqksj1p…`](https://testnet.nearblocks.io/txns/Gbqksj1prvkYoMoFubnp2RjrjXmaL7Tn9qjAuHywpsCF)). Order: `season-ctl open` →
  `season-ctl enter` + `run season` (commit phase: 07a, 08a, 09a, 12b–12f) → `season-ctl close` (close + 9 rounds by the
  outsider `atk7`) → `run low-gas-play` (13) and `run outsider-calls` (12h–12k) while matches were still `scheduled` →
  ops keeper `--keys 15` → `run season` again after settle (02b/02c, 07b–07d, 08b/08c, 09b, 10-s4).
  Season 4: 9 entries, 36 matches: 25 settled, 1 `duplicate_prompt` void (07b, the attack), 1 `callback_failed` void (13, the
  attack), 9 voided at settle because the keeper stopped mid-run (public RPC HTTP 429 on a view while 15 keys played, plus the
  parent briefly short of balance for 15 × 300 Tgas prepaid gas) and the +10 m play deadline passed before it was restarted.
  Fixed in `fix/rpc-429-retry` (#31: RPC 429/5xx retry). Timing: open → pubkey 34 s, settled 740 s after open.
  Attack season 2 (old slow preset, never closed in time) was closed and settled with no rounds (`state/attack-season-2.json`).
- Setup: `season-plan.json` lists 9 entries / 8 owners, unit 0.001 NEAR, bond 0.005 NEAR. It reuses season-1 house agents
  (their season-1 winnings claimed with their own function-call keys) plus a clone-farm owner `clone7` with four new agents.

## Findings

- **F1 (escalated, not patched here): the contract account `osd.baldingsucks7993.testnet` still holds a FullAccess key** (row 05c).
  Whoever holds it passes the keystore Predecessor rule outside the contract code: they can run the pinned referee with the game
  secrets on any stored ciphertexts (a prompt-probing oracle) and call the `#[private]` callbacks (`on_match`, `on_pubkey`)
  directly to forge results. Every outsider attack is refused (1, 4, 5); the hole is the deployer's own key.
  Fix: delete the full-access key after deploy (locked contract) or move upgrades behind a DAO or multisig.
  **Fix (interfaces-v5, PR `fix/seal-contract`):** every `#[private]` callback now requires exactly one promise result,
  so a direct call signed with the contract key is refused with `"not a callback"` (row 05c-b, live after redeploy);
  and the owner-only, one-way `seal` deletes all of the contract's access keys and freezes the per-season referee
  overrides (INTERFACE.md §6.4; `ops/scripts/seal.sh`). The keys stay during testing (upgrades); row 05c-after-seal is
  recorded by `run contract-key` once the owner has sealed. Until then 05c (the OutLayer keystore bypass) still works.

- **F2 (open): an outsider can void any scheduled match with a low-gas `play_match`** (row 13-50, live on season 4).
  `play_match` has no prepaid-gas floor: with 50 Tgas the OutLayer `request_execution` receipt fails with "Exceeded the prepaid
  gas", `on_match` voids the one-shot match (`callback_failed`) and it can only be refunded. For ~0.02 NEAR per match anyone can
  void a rival's matches (unranked rival, or a skewed leaderboard). Fix: `require!(env::prepaid_gas() >= Gas::from_tgas(250))`
  (or a computed floor: own work + OutLayer + the 40 Tgas callback) in `play_match`; a contract change, so it needs an ADR.

- **F3 (fixed, interfaces-v6): the season secrets profile was owned by the deployer** (`baldingsucks7993.testnet/osd-ad40dcf455fa`).
  The OutLayer keystore keys each row by its `store_secrets` signer, and only that account can re-store, re-scope
  (`update_access`) or delete it, so even after seal the deployer could whitelist itself and probe prompts, or plant a known seed.
  **Fix (PR #32):** a new profile `osd.baldingsucks7993.testnet/osd-ad40dcf455fa-c` was stored **signed by the contract account**
  (fresh TEE seed), and the config was switched with the owner-only `set_secrets` (refused after seal). The old row was deleted
  after seasons 1–4 settled, which destroys the old seed: past ciphertexts can no longer be decrypted by anyone. After seal the
  contract has no keys, so no account can sign as the owner and the profile is immutable by construction (rows 14a/14b; trust that
  remains: the OutLayer operator). Note: the 05c control derives the season-1 pubkey from the *config* profile. With the new seed
  it no longer matches seasons 1–4 (expected; seasons from 5 on use the new seed).

## Run

```sh
pnpm --filter @osd/attacks run no-season      # every attack that needs no live season, in parallel (~2–3 min)
pnpm --filter @osd/attacks run season         # attacks bound to the live attack season (phase-aware; no-op without one)
pnpm --filter @osd/attacks run <attack>       # forged-callback | replay | agent-key | outsider-outlayer | wrong-wasm |
                                              # contract-key | tampered-sig | duplicate-prompt | commitment-mismatch | clone-farm |
                                              # injection | withholding | outsider-calls | low-gas-play
                                              # (ATK_NO_SEASON=1 limits replay / injection / outsider-calls to season 1)
pnpm --filter @osd/attacks run season-ctl <step>  # setup | open | enter | close | status (attack-season orchestration)
pnpm --filter @osd/attacks run render         # regenerate the table below from results.json
pnpm --filter @osd/attacks run spend <snap> [base]   # balance snapshot; diff against <base> (default "start")
```

`run no-season` signs many transactions concurrently, several from the outsider `atk7` (nonces are allocated per key in
`send()`). Each tx reserves its prepaid gas at the pessimistic gas price, so `atk7` needs about 0.8 NEAR, or some txs are
rejected with `NotEnoughBalance` (the script warns).

Season-bound attacks are phase-aware: run during the commit window they perform their commit (duplicate prompt, mismatched
commitment, clone farm, early lifecycle calls); run again after play they verify the outcome. Keys are read from
`~/.near-credentials/testnet/` at runtime and never printed.

## Results

<!-- results:begin (generated by `pnpm --filter @osd/attacks run render`; edit results.json, not this table) -->
| # | Attack | Expected | Actual | Result | Tx |
|---|---|---|---|---|---|
| 01a | Forged on_match (season 1 match) from outsider | refused: "Method on_match is private" (predecessor ≠ contract) | refused: Smart contract panicked: Method on_match is private | PASS | [`EUup4oHmd4…`](https://testnet.nearblocks.io/txns/EUup4oHmd4xLfmY2LQefnMUmovLjPucd1NZyP8aEnx9t) |
| 01b | Forged on_pubkey from outsider | refused: "Method on_pubkey is private" (predecessor ≠ contract) | refused: Smart contract panicked: Method on_pubkey is private | PASS | [`2yrNrepRV4…`](https://testnet.nearblocks.io/txns/2yrNrepRV4yehEcPaM1dWsU7zzhTYRcwdSQxKXt3ys7G) |
| 01c | Forged on_agent_created (mint a 100 NEAR budget) from outsider | refused: "Method on_agent_created is private" (predecessor ≠ contract) | refused: Smart contract panicked: Method on_agent_created is private | PASS | [`8bHeTfYLc6…`](https://testnet.nearblocks.io/txns/8bHeTfYLc6WbdQ8nb2Uv73yDULkyvANXYWsubfFMycE1) |
| 02a | Replay settled season-1 match (season settled) | refused ("season not in play"), OutLayer not called, match unchanged | refused: Smart contract panicked: season not in play; OutLayer receipts: none; match unchanged | PASS | [`AkQY4PgRW5…`](https://testnet.nearblocks.io/txns/AkQY4PgRW5vrwvrY5n3vjKgoktkGXERTyxLh51kbskFq) |
| 02b | Replay settled attack-season match (season 4), args reversed | refused ("season not in play"), OutLayer not called, match unchanged | refused: Smart contract panicked: season not in play; OutLayer receipts: none; match unchanged | PASS | [`BsFJgqoBHH…`](https://testnet.nearblocks.io/txns/BsFJgqoBHHmhzsx6h1cd5QeanUP446KyymMQJfWZZx7Z) |
| 02c | Replay refunded attack-season match (callback_failed) | refused ("season not in play"), OutLayer not called, match unchanged | refused: Smart contract panicked: season not in play; OutLayer receipts: none; match unchanged | PASS | [`U9znTcGGF7…`](https://testnet.nearblocks.io/txns/U9znTcGGF7TVWbPiKhSHxPs2pxyrQXxZ4KWk1p7dttG) |
| 03a | FC key: Transfer 0.1 NEAR out of the agent account | rejected: RequiresFullAccess | rejected before inclusion: InvalidAccessKeyError RequiresFullAccess | PASS | – |
| 03b | FC key: AddKey (full access) to the agent account | rejected: RequiresFullAccess | rejected before inclusion: InvalidAccessKeyError RequiresFullAccess | PASS | – |
| 03c | FC key: DeleteAccount (beneficiary = attacker) | rejected: RequiresFullAccess | rejected before inclusion: InvalidAccessKeyError RequiresFullAccess | PASS | – |
| 03d | FC key: call non-allowed method refund_void on the contract | rejected: MethodNameMismatch | rejected before inclusion: InvalidAccessKeyError {MethodNameMismatch:{method_name:refund_void}} | PASS | – |
| 03e | FC key: allowed method name `commit` on another receiver (outlayer.testnet) | rejected: ReceiverMismatch | rejected before inclusion: InvalidAccessKeyError {ReceiverMismatch:{ak_receiver:osd.baldingsucks7993.testnet,tx_receiver:outlayer.testnet}} | PASS | – |
| 03f | FC key: `commit` with 1 yoctoNEAR attached | rejected: DepositWithFunctionCall | rejected before inclusion: InvalidAccessKeyError DepositWithFunctionCall | PASS | – |
| 03g | Control: FC key calls allowed `claim` (season 1) | accepted by the key (claimable → budget, or contract says "nothing claimable") | refused: Smart contract panicked: nothing claimable (claimable before: 0) | PASS | [`CcsfRXM3g6…`](https://testnet.nearblocks.io/txns/CcsfRXM3g6fvdJ5CeHVXenVXXfdKngUX11bXY5rB2MG3) |
| 04a | Outsider runs pinned referee with secrets_ref osd-ad40dcf455fa on two sealed season-1 entries | OutLayer keystore refuses the secret (Predecessor whitelist = [contract]); no output | execution_completed success=false: Access denied by access condition — signer atk7.baldingsucks7993.testnet, called from atk7.baldingsucks7993.testnet. Check the access conditions configured by the secret owner. | PASS | [`3RwE5scVPE…`](https://testnet.nearblocks.io/txns/3RwE5scVPERvh3yKjY5dwew2d4cv2vysedGPxPdJFkzg) |
| 04b | Outsider runs pinned referee without secrets (WASM-level predecessor check) | referee returns error predecessor_not_allowed (no decryption, no LLM call) | execution_completed success=true; output: {"error":"predecessor_not_allowed","match_key":"1:clique-amber.osd.baldingsucks7993.testnet:def-quarantine.osd.baldingsucks7993.testnet"} | PASS | [`GhKFMBwSHM…`](https://testnet.nearblocks.io/txns/GhKFMBwSHMWM3WvHu7e3KkBwVhjp1uj6DJpZoNM2qx53) |
| 05a | Whitelisted predecessor (contract key) + attacker probe WASM (b6e46bab…) + game secrets_ref | secret not released to a WASM whose hash ≠ WasmHash(ad40dcf4…): PROTECTED_SEASON_SEED and NEARAI_API_KEY absent (or job refused) | ran without the secret: season_seed_present=false, nearai_key_present=false (predecessor osd.baldingsucks7993.testnet; env names: ATTACHED_USD NEAR_BLOCK_HEIGHT NEAR_BLOCK_TIMESTAMP NEAR_CONTRACT_ID NEAR_GAS_BURNT NEAR_MAX_EXECUTION_SECONDS NEAR_MAX_INSTRUCTIONS NEAR_MAX_MEMORY_MB NEAR_NETWORK_ID NEAR_PAYMENT_YOCTO NEAR_PREDECESSOR_ID NEAR_RECEIPT_ID NEAR_RELAYER_ID NEAR_REQUEST_ID NEAR_RPC_PROXY_AVAILABLE NEAR_SENDER_ID NEAR_SIGNER_PUBLIC_KEY NEAR_TRANSACTION_HASH NEAR_USER_ACCOUNT_ID OUTLAYER_CALL_ID OUTLAYER_EXECUTION_TYPE USD_PAYMENT) | PASS | [`9JxdkHRUTd…`](https://testnet.nearblocks.io/txns/9JxdkHRUTdFuq4XWJU5QQiAQsCrRUnfGD5hhpKruK8ob) |
| 05b | Outsider + attacker probe WASM + game secrets_ref | secret not released to a WASM whose hash ≠ WasmHash(ad40dcf4…): PROTECTED_SEASON_SEED and NEARAI_API_KEY absent (or job refused) | ran without the secret: season_seed_present=false, nearai_key_present=false (predecessor atk7.baldingsucks7993.testnet; env names: ATTACHED_USD NEAR_BLOCK_HEIGHT NEAR_BLOCK_TIMESTAMP NEAR_CONTRACT_ID NEAR_GAS_BURNT NEAR_MAX_EXECUTION_SECONDS NEAR_MAX_INSTRUCTIONS NEAR_MAX_MEMORY_MB NEAR_NETWORK_ID NEAR_PAYMENT_YOCTO NEAR_PREDECESSOR_ID NEAR_RECEIPT_ID NEAR_RELAYER_ID NEAR_REQUEST_ID NEAR_RPC_PROXY_AVAILABLE NEAR_SENDER_ID NEAR_SIGNER_PUBLIC_KEY NEAR_TRANSACTION_HASH NEAR_USER_ACCOUNT_ID OUTLAYER_CALL_ID OUTLAYER_EXECUTION_TYPE USD_PAYMENT) | PASS | [`BsHjyLhJP8…`](https://testnet.nearblocks.io/txns/BsHjyLhJP8f6uXJNa7kXsuq6kXTVh6zh1akB7HMvxCew) |
| 05c | Control: contract FULL-ACCESS key + pinned WASM + game secrets, signed outside the contract code | secrets released (same predecessor, right hash) → shows 05a/05b got no secret because of the WasmHash binding alone | execution_completed success=true; derived season-1 pubkey matches get_season_pubkey(1); contract has 1 FullAccess key(s) | **FINDING** | [`DvooRgnbpJ…`](https://testnet.nearblocks.io/txns/DvooRgnbpJxbKfpr9wtD3r69ikCcgmh4co6nJN9eMpd8) |
| 05c-b | Contract FULL-ACCESS key calls #[private] on_match directly (passes the predecessor check) | refused: "not a callback" (0 promise results), or unsignable after seal; match unchanged | refused: Smart contract panicked: not a callback; match unchanged: true; contract keys: 1; is_sealed: false | PASS | [`CbfNKs5jQh…`](https://testnet.nearblocks.io/txns/CbfNKs5jQh77F6vfag9RGs7sHpXzswyFh6hBKrtXpayS) |
| 06a | Control: genuine NEAR AI signatures | sig_a_ok = sig_b_ok = true; settled | play_match → "settled CC"; status "settled"; moves "C""C"; payoffs 3/3; sig_a_ok=true sig_b_ok=true | PASS | `AHU71FCeeQ…` (sandbox) |
| 06b | Tampered: a_sig one hex digit flipped; b_signed_text response hash edited | sig_a_ok = sig_b_ok = false; match still settles with the referee moves | play_match → "settled DC"; status "settled"; moves "D""C"; payoffs 5/1; sig_a_ok=false sig_b_ok=false | PASS | `AJ16wVqvCc…` (sandbox) |
| 06c | Tampered: signatures swapped between sides; one proof dropped | sig flags false; settles | play_match → "settled DC"; status "settled"; moves "D""C"; payoffs 5/1; sig_a_ok=false sig_b_ok=false | PASS | `52kgd5yg7a…` (sandbox) |
| 07a | Commit byte-identical prompt from 2 owners (h16, h19) | both commits accepted (salted commitments differ; no on-chain duplicate check by design, INTERFACE §5) | accepted; commitments 384dec2a… ≠ 998b27e1… | PASS | [`4ueB2CfRbE…`](https://testnet.nearblocks.io/txns/4ueB2CfRbEYHPmMdDezYnoofwRA3vDqEzHegkgWDwNWX) |
| 07b | Duplicate pair meets: referee detects byte-equal prompts | match void, void_reason duplicate_prompt, no LLM call, no payoffs | status refunded, void_reason duplicate_prompt, moves -/- | PASS | – |
| 07c | refund_void on the duplicate_prompt match | match → refunded; 3 units (3000000000000000000000 yocto) credited to each side's claimable | ; status now refunded | PASS | – |
| 07d | Second refund_void on the same match (double refund) | refused: "match not void" | refused: Smart contract panicked: match not void | PASS | [`7qQENsM5T3…`](https://testnet.nearblocks.io/txns/7qQENsM5T3kQViPxWEf7qcPcniFGUzjfqrU8fKFQtv6f) |
| 08a | Commit ciphertext(prompt, saltA) with commitment(prompt, saltB) as exploiter | accepted on chain (the contract cannot decrypt; checked in the TEE) | accepted | PASS | [`5RcS74T8zV…`](https://testnet.nearblocks.io/txns/5RcS74T8zVUdD1MMu9yPM67ifQudPiq2zASzNK9ZbS5w) |
| 08b | Mismatched entry plays its matches (5/8 settled) | every match: this side F (0), opponent 3, +3 units to the pool; no LLM call | 5/5 settled matches F; payoffs 0/3 +3 pool: yes | PASS | – |
| 08c | Settlement of the forfeiting entry | bond (5000000000000000000000 yocto) withheld into the pool: claimable = unused stake + void refunds = 12000000000000000000000 yocto | claimable 12000000000000000000000 yocto (no bond); rank 9, avg 0 | PASS | – |
| 09a | 4th agent of one owner commits (cap max_entries_per_owner = 3) | refused: "owner reached max_entries_per_owner"; owner keeps 3 entries | refused: Smart contract panicked: owner reached max_entries_per_owner; owner has 3 entries | PASS | [`5DWABmzBG4…`](https://testnet.nearblocks.io/txns/5DWABmzBG4qYyLSGiqUB9yJE7Pz4XRGcpetcWBKM7Amc) |
| 09b | Ranking excludes the 3 clone-vs-clone matches (leaderboard, season 4, settled) | matches_counted / total_payoff_counted use only matches vs other owners; same-owner matches still pay out | all 9 rows match the cross-owner recount; clones: c-tft counted 4/6 settled, c-delim counted 5/6 settled, c-charm counted 4/5 settled; same-owner matches: settled DD, settled DD, refunded | PASS | – |
| 10-all | Injection win rate, pooled (seasons 1, 4) | report; defenders should not be exploited; the referee integrity holds (injection changes only the opponent LLM's move, never payoffs, prompts or keys) | pooled 1/20 = 5.0%; vs defenders 0/8 = 0.0% | PASS | – |
| 10-s1 | Injection win rate, season 1 (settled; injectors: inj-override) | report: injector wins = injector D while opponent C (talked into cooperating) | overall 1/9 = 11.1% (per injector: inj-override 1/9); vs defenders 0/1 = 0.0%; vs others 1/8 = 12.5%; opponents' C rate vs injectors 11.1% vs non-injectors 45.8% | PASS | – |
| 10-s4 | Injection win rate, season 4 (settled; injectors: inj-override, c-charm, c-delim) | report: injector wins = injector D while opponent C (talked into cooperating) | overall 0/11 = 0.0% (per injector: inj-override 0/3, c-charm 0/4, c-delim 0/4); vs defenders 0/7 = 0.0%; vs others 0/4 = 0.0%; opponents' C rate vs injectors 0.0% vs non-injectors 57.1% | PASS | – |
| 11 | Withhold the reveal after seeing the opponent (classic commit-reveal attack) | n/a: there is no reveal step to withhold | n/a. commit stores the ECIES ciphertext itself (season 1 entry clique-amber: 542 B on chain); only the TEE (season key from PROTECTED_SEASON_SEED) decrypts it, at play time, without the player. Nothing to withhold after commit; the commit is final (no overwrite). The nearest levers: commit garbage → F + bond lost (attack 8); refuse to enter → no stake; void a match by starving play_match gas → see 13. | PASS | n/a |
| 12a | Outsider open_season | refused: "owner only" | refused: Smart contract panicked: owner only | PASS | [`J2orBAJsRx…`](https://testnet.nearblocks.io/txns/J2orBAJsRxacCmeKvZ2GvSEf3ff2pwvSChQUU23pQiDB) |
| 12b | Outsider close_commits before the commit deadline | refused: "commit deadline not reached" | refused: Smart contract panicked: commit deadline not reached | PASS | [`DvEuvfjNcF…`](https://testnet.nearblocks.io/txns/DvEuvfjNcFNk5nos7tWW4VmfNVYtP7MdFGGMC2d86tjv) |
| 12c | Outsider schedule_round during commit | refused: "season not in play" | refused: Smart contract panicked: season not in play | PASS | [`2b1hUcQk2h…`](https://testnet.nearblocks.io/txns/2b1hUcQk2hhaJRvobNHRafK4WwAKKdQp5S7L8435oPjT) |
| 12d | Early play_match during commit (two entered agents) | refused: "season not in play"; OutLayer not called | refused: Smart contract panicked: season not in play | PASS | [`8F9qhR354T…`](https://testnet.nearblocks.io/txns/8F9qhR354T2NGBqvYToksff4PMCY2V8vkdLGRNSyokN1) |
| 12e | Outsider settle_season during commit | refused: "season not in play" | refused: Smart contract panicked: season not in play | PASS | [`A78upwKq2D…`](https://testnet.nearblocks.io/txns/A78upwKq2DwvUJ5Yj1okijUQoe9K3acFRHmrNaeZQZaq) |
| 12f | Outsider commits on behalf of someone else's agent | refused: "caller must be the agent or its owner" | refused: Smart contract panicked: caller must be the agent or its owner | PASS | [`DiLd7htQmb…`](https://testnet.nearblocks.io/txns/DiLd7htQmbzmFnBybDrRz31E43AJjbKsXkbHasbkVna4) |
| 12g | Outsider withdraw from another owner's agent budget | refused: "not owner" | refused: Smart contract panicked: not owner | PASS | [`HA9tLjJnsN…`](https://testnet.nearblocks.io/txns/HA9tLjJnsNxDH57Up3UfnS9hDPUpEGDmcQxZF1jBh246) |
| 12h | Outsider settle_season while matches are unfinished, before the play deadline | refused: "unfinished matches before play deadline" | refused: Smart contract panicked: unfinished matches before play deadline | PASS | [`7SWqUrcE9e…`](https://testnet.nearblocks.io/txns/7SWqUrcE9e7hC5pmmoSE9uG6NbePDaAcvQEKW9rQxoKK) |
| 12i | refund_void on a match that is pending for < 250 blocks (grab the stake back mid-run) | refused: "match not void" | refused: Smart contract panicked: match not void | PASS | [`32KsH8KNVT…`](https://testnet.nearblocks.io/txns/32KsH8KNVTeRo36E4A3MuchoW4fDqvsJwmFGGBgACrpm) |
| 12j | Outsider schedule_round after all rounds are scheduled | refused: "all rounds scheduled" | refused: Smart contract panicked: all rounds scheduled | PASS | [`6TQjVnybu9…`](https://testnet.nearblocks.io/txns/6TQjVnybu9svg9pLQBnrrmu6ixMpJ7EQzzeFgd8QB4wM) |
| 12k | Late commit after the commit deadline | refused: "season not in commit" | refused: Smart contract panicked: caller must be the agent or its owner | PASS | [`F5aDeqTSuk…`](https://testnet.nearblocks.io/txns/F5aDeqTSukwnuQyw2A5m1VPgHZ22Y6pd2ox1VTFy3NKe) |
| 12l | Outsider close_commits on settled season 1 | refused: "season not in commit" | refused: Smart contract panicked: season not in commit | PASS | [`7AJk5WS4t1…`](https://testnet.nearblocks.io/txns/7AJk5WS4t1j1CYwStuhWSh6bHVm3MDTMv3neE23wJKDf) |
| 12m | Outsider schedule_round on settled season 1 (re-schedule a played pair) | refused: "season not in play" | refused: Smart contract panicked: season not in play | PASS | [`DDZcKSo6kZ…`](https://testnet.nearblocks.io/txns/DDZcKSo6kZgzdCfd8CVwqrTjZpQr9HpLMpUoQGj1RnJN) |
| 12n | Outsider settle_season again on settled season 1 (double payout) | refused: "season not in play" | refused: Smart contract panicked: season not in play | PASS | [`7QMkmmkYFx…`](https://testnet.nearblocks.io/txns/7QMkmmkYFxaTcgSqKhpTnKQfJuwijB68aTN3CduphGiX) |
| 12o | Outsider refund_void on a settled season-1 match (pull the stakes back) | refused: "match not void" | refused: Smart contract panicked: match not void | PASS | [`4HmxW2E1nL…`](https://testnet.nearblocks.io/txns/4HmxW2E1nLvjYHNNBcXXtzH2VHkKSjgLBpX3feCNo1R3) |
| 12p | Outsider commits someone else's agent into settled season 1 | refused: "caller must be the agent or its owner" | refused: Smart contract panicked: caller must be the agent or its owner | PASS | [`8rmwphaWw2…`](https://testnet.nearblocks.io/txns/8rmwphaWw2hAGXaSrJVJAUWo9aYisMdR8AHRJHQmjkMt) |
| 13-50 | Outsider play_match with 50 Tgas (exploiter vs tft-oneshot) | refused for too little gas, or the match is played normally (never voided by an outsider) | tx ok; OutLayer receipts FAILED (Exceeded the prepaid gas.); match now void (callback_failed) | **FINDING** | [`D65ek8DGCK…`](https://testnet.nearblocks.io/txns/D65ek8DGCKLPqKkcR6j4fpVsbBF8qFJLEXPc5XqhEJoo) |
| 14a | secrets-owner: previous secrets owner baldingsucks7993.testnet calls keystore update_access(AllowAll) on the contract's profile osd-ad40dcf455fa-c | refused ("Secrets not found": rows are keyed by the caller); the contract-owned row is unchanged | refused: Smart contract panicked: panicked at src/secrets.rs:661:14:\nSecrets not found; contract-owned row unchanged: true | PASS | [`3Bxt7AkHC3…`](https://testnet.nearblocks.io/txns/3Bxt7AkHC3PeoHXo6VHVjMefRCWUsN5U53oQVCtUQVkZ) |
| 14b | secrets-owner: who can modify the season secrets profile after seal | get_config().secrets_owner = osd.baldingsucks7993.testnet; keystore row WasmHash(ad40dcf4…) + Predecessor[osd.baldingsucks7993.testnet] under it; after seal (0 keys) no account can sign as the owner, so nobody can re-store, re-scope or delete it (OutLayer operator trusted) | secrets ref osd.baldingsucks7993.testnet/osd-ad40dcf455fa-c; row present: true; Predecessor[contract] only: true; contract keys: 1; is_sealed: false; not sealed yet: the contract key can still modify it until seal | PASS | – |

54 rows: 52 pass, 2 finding(s), 0 fail. Updated 2026-11-11T13:37:53.943Z.
<!-- results:end -->
