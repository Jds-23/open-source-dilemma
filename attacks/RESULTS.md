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
  calls, 13 low-gas play) run with `run season` against the attack season in `state/attack-season.json`.
  The commit-phase rows 07a, 08a, 09a, 12b–12f come from attack season **2** (opened 2026-11-10 on the old slow preset).
  Season 2 has been stuck in `commit` since its deadline (2026-11-10 21:03 UTC; play deadline 23:43 UTC also passed):
  nobody called `close_commits`. It blocks `open_season` until it is closed (`close_commits` is permissionless). Since the play
  deadline has passed too, `close_commits` + `settle_season` will void and refund every one of its matches, so the outcome rows
  (F for the mismatched commitment, the duplicate pair's scores, 13) must come from a new attack season on the fast-attack preset,
  once the keeper speed-up lands. Left as is on purpose.
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
| 02a | Replay settled season-1 match (season settled) | refused ("season not in play"), OutLayer not called, match unchanged | refused: Smart contract panicked: season not in play; OutLayer receipts: none; match unchanged | PASS | [`AathtYugpB…`](https://testnet.nearblocks.io/txns/AathtYugpBCTcxZ42eS9TGXxpNbm7H4bJU8LBwnqetYp) |
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
| 06a | Control: genuine NEAR AI signatures | sig_a_ok = sig_b_ok = true; settled | play_match → "settled CC"; status "settled"; moves "C""C"; payoffs 3/3; sig_a_ok=true sig_b_ok=true | PASS | `AHU71FCeeQ…` (sandbox) |
| 06b | Tampered: a_sig one hex digit flipped; b_signed_text response hash edited | sig_a_ok = sig_b_ok = false; match still settles with the referee moves | play_match → "settled DC"; status "settled"; moves "D""C"; payoffs 5/1; sig_a_ok=false sig_b_ok=false | PASS | `AJ16wVqvCc…` (sandbox) |
| 06c | Tampered: signatures swapped between sides; one proof dropped | sig flags false; settles | play_match → "settled DC"; status "settled"; moves "D""C"; payoffs 5/1; sig_a_ok=false sig_b_ok=false | PASS | `52kgd5yg7a…` (sandbox) |
| 07a | Commit byte-identical prompt from 2 owners (h16, h19) | both commits accepted (salted commitments differ; no on-chain duplicate check by design, INTERFACE §5) | accepted; commitments eb61035f… ≠ 3f0f59a4… | PASS | [`6PULLvPQLD…`](https://testnet.nearblocks.io/txns/6PULLvPQLDqPKqg22uPj6ViwjstW12pWCU6vPtRfre6w) |
| 08a | Commit ciphertext(prompt, saltA) with commitment(prompt, saltB) as exploiter | accepted on chain (the contract cannot decrypt; checked in the TEE) | accepted | PASS | [`4NuuDZF74w…`](https://testnet.nearblocks.io/txns/4NuuDZF74wontb6kVfgBWDJzgAoCNA7dEjCERjXdcTMj) |
| 09a | 4th agent of one owner commits (cap max_entries_per_owner = 3) | refused: "owner reached max_entries_per_owner"; owner keeps 3 entries | refused: Smart contract panicked: owner reached max_entries_per_owner; owner has 3 entries | PASS | [`872MjiaHZt…`](https://testnet.nearblocks.io/txns/872MjiaHZtMPCg9TAXJfaV1BqpY75cp1jjWEsasu7zQL) |
| 10-all | Injection win rate, pooled (seasons 1) | report; defenders should not be exploited; the referee integrity holds (injection changes only the opponent LLM's move, never payoffs, prompts or keys) | pooled 1/9 = 11.1%; vs defenders 0/1 = 0.0% | PASS | – |
| 10-s1 | Injection win rate, season 1 (settled; injectors: inj-override) | report: injector wins = injector D while opponent C (talked into cooperating) | overall 1/9 = 11.1% (per injector: inj-override 1/9); vs defenders 0/1 = 0.0%; vs others 1/8 = 12.5%; opponents' C rate vs injectors 11.1% vs non-injectors 45.8% | PASS | – |
| 11 | Withhold the reveal after seeing the opponent (classic commit-reveal attack) | n/a: there is no reveal step to withhold | n/a. commit stores the ECIES ciphertext itself (season 1 entry clique-amber: 542 B on chain); only the TEE (season key from PROTECTED_SEASON_SEED) decrypts it, at play time, without the player. Nothing to withhold after commit; the commit is final (no overwrite). The nearest levers: commit garbage → F + bond lost (attack 8); refuse to enter → no stake; void a match by starving play_match gas → see 13. | PASS | n/a |
| 12a | Outsider open_season | refused: "owner only" | refused: Smart contract panicked: owner only | PASS | [`C2BKGvoKJw…`](https://testnet.nearblocks.io/txns/C2BKGvoKJw3DxRJMyYKBpfnZoN9uTaFgdjuFa7ixBiKz) |
| 12b | Outsider close_commits before the commit deadline | refused: "commit deadline not reached" | refused: Smart contract panicked: commit deadline not reached | PASS | [`6n3dSsnmC8…`](https://testnet.nearblocks.io/txns/6n3dSsnmC8sYMk8FFvviE93B9ox9QA2Fh6td874n4PBF) |
| 12c | Outsider schedule_round during commit | refused: "season not in play" | refused: Smart contract panicked: season not in play | PASS | [`7QGeQkf5FH…`](https://testnet.nearblocks.io/txns/7QGeQkf5FHQcRA2HaMoysFCL2nbP5VbiUeVpqqDmMYHH) |
| 12d | Early play_match during commit (two entered agents) | refused: "season not in play"; OutLayer not called | refused: Smart contract panicked: season not in play | PASS | [`2EDsvZVnWb…`](https://testnet.nearblocks.io/txns/2EDsvZVnWbVuDvuuzooCbLk9GGYP6tCQQXcWA3MwtZe5) |
| 12e | Outsider settle_season during commit | refused: "season not in play" | refused: Smart contract panicked: season not in play | PASS | [`HbNa23zdad…`](https://testnet.nearblocks.io/txns/HbNa23zdadsqfjF56zEg1FjuP22CzAGWpfcknyh2ALmf) |
| 12f | Outsider commits on behalf of someone else's agent | refused: "caller must be the agent or its owner" | refused: Smart contract panicked: caller must be the agent or its owner | PASS | [`BxWA9UyG9B…`](https://testnet.nearblocks.io/txns/BxWA9UyG9B6Z2j61pY859dsgQkRuL7mmqu5gyEi7MN6u) |
| 12g | Outsider withdraw from another owner's agent budget | refused: "not owner" | refused: Smart contract panicked: not owner | PASS | [`H1R5d3ehz7…`](https://testnet.nearblocks.io/txns/H1R5d3ehz7NAub9pCvP8yxramD3C6R2vvmK7igMag2Dv) |
| 12l | Outsider close_commits on settled season 1 | refused: "season not in commit" | refused: Smart contract panicked: season not in commit | PASS | [`AtzB7KRP2i…`](https://testnet.nearblocks.io/txns/AtzB7KRP2iC1QoyDWu5MinmwwXe7Z1KMJtTdwXj1124) |
| 12m | Outsider schedule_round on settled season 1 (re-schedule a played pair) | refused: "season not in play" | refused: Smart contract panicked: season not in play | PASS | [`FA2gYt6ByP…`](https://testnet.nearblocks.io/txns/FA2gYt6ByPTnXJbavrNmgp9tKytnHjJhpzoUrTo6LyMQ) |
| 12n | Outsider settle_season again on settled season 1 (double payout) | refused: "season not in play" | refused: Smart contract panicked: season not in play | PASS | [`32Lc5cbZRW…`](https://testnet.nearblocks.io/txns/32Lc5cbZRWNXqS5WosyfvFzngK5nkL2C9Kuc5se3RrLF) |
| 12o | Outsider refund_void on a settled season-1 match (pull the stakes back) | refused: "match not void" | refused: Smart contract panicked: match not void | PASS | [`5wyrPfuUJr…`](https://testnet.nearblocks.io/txns/5wyrPfuUJrRXaKdNe2e4wgNwXiXbzvtNzuAFWXC9tn2f) |
| 12p | Outsider commits someone else's agent into settled season 1 | refused: "caller must be the agent or its owner" | refused: Smart contract panicked: caller must be the agent or its owner | PASS | [`D2moCVNZf9…`](https://testnet.nearblocks.io/txns/D2moCVNZf9qdGRmuPUxQXkWj9ApycX7KqXkffjoE1bfn) |

37 rows: 36 pass, 1 finding(s), 0 fail. Updated 2026-11-11T12:38:36.852Z.
<!-- results:end -->
