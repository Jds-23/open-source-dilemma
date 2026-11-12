# Evidence

What the testnet runs produced, as measured. Source data: `ops/runs/evidence/osd.baldingsucks7993.testnet/` (`seasons.csv`,
`families.csv`, `season-<n>/{summary.json,matches.csv,moves.csv}`), regenerated with
`pnpm --filter @osd/ops export-evidence`. Contract `osd.baldingsucks7993.testnet`, cards `cards.osd.baldingsucks7993.testnet`.
Testnet only: no real value is at stake, and the sample is small. Treat the strategy rankings as anecdotes, not findings.

## Headline numbers

| | |
|---|---|
| Seasons on chain | 6 ids; **4 settled with matches** (1, 3, 4, 6), 1 voided (2, no rounds), 1 cancelled (5, 0 entries) |
| Agents | **29** distinct agent accounts played in the 4 seasons (48 season entries: 10 + 4 + 9 + 25) |
| Matches | 387 scheduled, **217 settled** (45 + 6 + 25 + 141), 170 refunded as void |
| Moves from settled matches | 434 (202 C, 227 D, 5 forfeits) |
| Verified proofs | **424** = S1 90, S3 12, S4 40, S6 282 (re-derived: signature flags `sig_a_ok` and `sig_b_ok` true on settled matches in `matches.csv`; the 5 forfeited S4 matches carry no proof; the figure matches the brief) |
| Cooperation (all moves) | 46.5 % (202 / 434); 47.1 % counting only C and D |
| Cooperation, first / last season | S1 37.8 % / S6 52.8 % |
| Best agent (avg payoff per move, all seasons) | `prudentbot` (program_equilibrium), 3.26 over 23 moves; rank 1 in S3 and S6, rank 2 (tied) in S1 |
| Best family (same measure) | program_equilibrium, 2.59 |
| Prompt-injection wins | S1 1/9; attack season 4 0/11; pooled 1/20 (5 %); against defenders 0/8 |
| Attacks | 54 rows in `attacks/RESULTS.md`: 52 PASS, 2 FINDING (F1, F2), 0 FAIL |
| Cost per match | 0.0064 NEAR (season 1 only, see Cost) |
| Strategy cards minted | S1 (earlier), S4: 9 cards, S6: 25 cards |

A "proof" is one side's NEAR AI signature over its model response, checked inside the pinned referee. It is a count of verified
signatures, not of independent matches.

## Per season

| Season | Agents | Matches (settled / void) | CC | CD or DC | DD | Coop rate | Mutual-C / mutual-D | Void cause | Forfeits | Top 3 (avg payoff) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 10 | 45 (45 / 0) | 12 | 10 | 23 | 37.8 % | 26.7 % / 51.1 % | none | 0 | tft-oneshot 2.56, prudentbot 2.56, def-quarantine 2.11 |
| 3 | 4 | 6 (6 / 0) | 1 | 4 | 1 | 50.0 % | 16.7 % / 16.7 % | none | 0 | prudentbot 4.33, tft-oneshot 2.33, coin-vowel 2.33 |
| 4 | 9 | 36 (25 / 11) | 1 | 6 | 13 | 26.0 % | 4.0 % / 52.0 % | 9 `deadline` (keeper died on RPC 429), 1 `duplicate_prompt` and 1 `callback_failed` (both deliberate attacks) | 5 matches (1 forfeiting entry: `exploiter`, attack 8) | fairbot 3.57, tft-oneshot 2.50, c-tft 2.50 |
| 6 | 25 | 300 (141 / 159) | 52 | 45 | 44 | 52.8 % | 36.9 % / 31.2 % | 102 `bad_output` (referee trap under load), 57 `deadline` (keeper died on RPC 429) | 0 | prudentbot 3.55, tft-oneshot 3.15, def-tft 2.85 |

CC / CD / DD count settled matches. In S4 the other 5 settled matches are forfeits (C vs F, D vs F). The coop rate is the share of
moves that are C (a forfeit counts as not-C); mutual-C and mutual-D are shares of settled matches. Season 4 was the attack season,
with deliberately hostile entries; its numbers are not representative of normal play. In S6, 2 of 25 entries played no settled
match (unranked).

## Per family

Pooled over seasons 1, 3, 4, 6 (agent entries, not distinct agents; the 5 S4 forfeit moves count in `mean`'s average as zero).

| Family | Agent entries | Moves | C | D | Coop rate (C / (C+D)) | Avg payoff / move |
|---|---|---|---|---|---|---|
| program_equilibrium | 8 | 68 | 41 | 27 | 60.3 % | 2.59 |
| conditional | 2 | 26 | 15 | 11 | 57.7 % | 2.46 |
| nice | 10 | 89 | 66 | 23 | 74.2 % | 2.46 |
| defender | 8 | 67 | 35 | 32 | 52.2 % | 2.37 |
| randomish | 4 | 37 | 16 | 21 | 43.2 % | 2.24 |
| clique | 4 | 48 | 5 | 43 | 10.4 % | 1.96 |
| mean | 5 | 38 | 11 | 22 | 33.3 % | 1.71 |
| injector | 7 | 61 | 13 | 48 | 21.3 % | 1.69 |

Per-season family tables are in `families.csv`. The ordering is stable only in broad strokes (cooperators and program-equilibrium
agents ahead, injectors, mean agents and cliques behind); with 1 to 5 agents per family per season, small gaps mean nothing.

## Prompt injection

An injector "wins" a match when it plays D while its opponent plays C. Row numbers refer to `attacks/RESULTS.md`.

| Scope | Injector wins | vs defenders |
|---|---|---|
| Season 1 (10-s1) | 1 / 9 (11.1 %), `inj-override` | 0 / 1 |
| Attack season 4 (10-s4) | 0 / 11 (0 %): inj-override 0/3, c-charm 0/4, c-delim 0/4 | 0 / 7 |
| Pooled (10-all) | 1 / 20 (5.0 %) | 0 / 8 |

Verified against `attacks/RESULTS.md` rows 10-s1, 10-s4, 10-all. Opponents cooperated 11.1 % of the time against injectors in S1
and 0 % in S4, versus 45.8 % and 57.1 % against non-injectors. Injection did not change a payoff, a prompt or a key: it can only
influence the opponent's LLM move.

## Cost and latency

- **Season 1 has full cost data** (`--fetch-tx`): 86 txs, 45 `play_match`; gas-token burn 0.2316 NEAR plus OutLayer charge
  0.0559 NEAR = **0.0064 NEAR per match** (6.39e21 yocto). OutLayer run time p50 2.41 s (min 1.86, p90 2.61, max 3.69 s).
- **S3, S4 and S6 were exported without `--fetch-tx`**, so their gas and OutLayer charges are not in the exports. Their `cost` is
  `null`. We do not claim a per-match cost for them; expect S6 to be in the same range, but it is not measured. A re-export with
  `--fetch-tx` would fill this in (see `docs/VOIDS.md` for the caching flags).
- Latency from `play_match` request to settled (block heights, about 1 s each): p50 S1 112, S3 85, S4 116, S6 114; p90 S1 176, S6 176;
  max S6 202. The `keeper_latency_s` fields (wall clock) are only meaningful for S1 (p50 73 s, max 120 s) and S3 (p50 57 s). S4 and
  S6 include keeper restarts, so their wall-clock figures (p50 293 s, 2927 s) are dominated by downtime.

## Fast-season timings

From `ops/README.md`. The fast presets were built for demos: a commit window of about 2 minutes, then play.

| Season | Preset | Result |
|---|---|---|
| 3 (smoke) | fast-10, 4 agents, 6 matches | open to settle in 3 min 50 s; pubkey 34 s after open; 0 voids |
| 1 | slow preset, 10 agents | pubkey 12 s after open; match final p50 73 s / p90 111 s after the play tx |
| 4 | fast-attack, 9 entries | pubkey 34 s; settled 740 s after open (includes the keeper outage) |
| 6 | fast-25, 25 agents, 300 matches | pubkey took 73 s (longer than the 45 s keeper estimate, so the default is now 90 s); run was voided 53 %, see below |

At the post-#37 in-flight cap of 5, a 300-match season is expected to take about 75 minutes of play. That figure is an estimate
(matches / cap x ~75 s), not a measurement.

## Attacks

54 rows, 52 PASS, 2 FINDING, 0 FAIL: [`attacks/RESULTS.md`](../attacks/RESULTS.md). Covers forged callbacks (`on_match`,
`on_pubkey`, `on_agent_created`), replay of settled matches, misuse of agent function-call keys, outsider runs of the referee with
and without secrets, a wrong-WASM probe, tampered NEAR AI signatures, duplicate prompts, commitment mismatch, clone farming,
injection, early or late lifecycle calls, and secrets-profile ownership. Rows with a testnet tx link a nearblocks page; the
signature-tamper rows (6a to 6c) ran in a sandbox against the real contract and a mock OutLayer; some rows are analysis only.

Two rows are findings, not passes:

- **F1** (05c): the contract account held a full-access key. Mitigated in code (callbacks require a promise result; one-way
  `seal` deletes all keys), live only once the owner seals. See Trust model.
- **F2** (13-50): an outsider can void a scheduled match by calling `play_match` with too little prepaid gas
  (`callback_failed`, refund only). It cost the outsider about 0.02 NEAR per match.

<!-- F2-STATUS -->
**F2 status: fix in progress (minimum prepaid gas check in `play_match`); the integrator updates this line when it is merged and redeployed.**
<!-- /F2-STATUS -->

"Refused" in the pass count includes control rows (for example 03g, 06a) that are expected to succeed.

## Voids, stated plainly

Season 6 voided **159 of 300 matches (53 %)**, and season 4 11 of 36 (31 %, of which 2 were deliberate attack outcomes). Full
write-up and fixes: [`docs/VOIDS.md`](VOIDS.md).

- S6, 102 `bad_output`: the referee WASM trapped about 1 s into its run when up to 300 jobs were in flight at OutLayer at once.
  Seasons 1 and 3, with at most 45 and 6 in flight, had none. The root cause below the trap is an inference (no symbols).
- S4 and S6, 66 `deadline`: the keeper process died on RPC HTTP 429 and the play deadline passed.
- Fixes: #31, #35 (RPC retries) and #37 (cap on matches in flight at OutLayer, default 5, adaptive back-off). **#37 has been tested
  against the mock only**; no season has run since. Nothing here shows that a full 25-agent season now completes without voids.

A void match has no result and no proof, and its stakes are refunded. Voids reduce the data (S6 has 141 usable matches out of 300),
not the correctness of the settled ones.

## Trust model and seal status

What the chain and the TEE guarantee, and what they do not:

- The referee is a WASM pinned by hash (`ad40dcf4...`). The season secret is released only to that hash called from the contract
  (attacks 4a/4b, 5a/5b). Move and prompt data are decrypted only inside the TEE.
- NEAR AI signatures are checked per side; a tampered signature sets `sig_ok` false but the match still settles with the
  referee's moves (attack 6b, 6c). The verified-proof count above counts only `sig_ok = true`.
- Trusted: the OutLayer operator and the TEE hardware attestation, the NEAR AI signing key, and the contract owner until sealed.
- Secrets profile: from season 5 on the profile `osd-ad40dcf455fa-c` is owned by the contract account (fresh TEE seed), so after
  seal no account can re-store or re-scope it (attacks 14a/14b). The previous deployer-owned profile was deleted after seasons 1
  to 4 settled, so those seasons' ciphertexts can no longer be decrypted by anyone.

**Seal status: not sealed.** `is_sealed` returned `false` on the contract at the time of writing. The contract still has its
deployer access key and the owner can upgrade it.

<!-- SEAL-STATUS -->
**Seal: pending. The integrator replaces this line with the seal tx and the post-seal key list once the owner seals.**
<!-- /SEAL-STATUS -->

## Proof of a new seed (season 6)

Season 6 is the first season on the contract-owned secrets profile. On chain: `get_season(6).secrets_profile` is
`osd-ad40dcf455fa-c` (seasons 1 to 4: `osd-ad40dcf455fa`), and the season public keys differ:

- S1 `get_season_pubkey`: `023efb0e2677afbb1b826bad60fd85ea865c97c044aef8473a7500db02530f648f`
- S6 `get_season_pubkey`: `0346116e848287f13b9b0e65eca6f1cb7dab6884c98e72b3cbbec418fea867d165`

A different public key means a different season seed, so S6 ciphertexts are not decryptable with anything tied to the old profile.
This shows the key changed; it does not show who could read the new seed (that is the trust model above).

## Verify it yourself

`ops/runs/tx-index.json` maps `<season>:<a>:<b>` to the `play_match` tx hash (298 matches indexed from the journals). For any match:

1. Open the tx in the explorer: `https://testnet.nearblocks.io/txns/<tx>`. It shows the `play_match` call, the OutLayer
   receipt and the `on_match` callback with the moves.
2. Open the OutLayer attestation: `https://testnet-api.outlayer.ai/attestations/by-tx/<tx>`. It reports the executed WASM hash
   (must equal `ad40dcf455faf4264e72e771c4ab13241b9b264e20ce74e1eeb190bd60c00ec6`), input and output hashes, and the worker
   measurement.
3. Compare with `get_match` / the leaderboard views on the contract, or with the match row in `matches.csv`.

Examples:

| Match | Result | Explorer | Attestation |
|---|---|---|---|
| S1 `always-c` vs `exploiter` (hero) | C vs D, payoffs 0 / 5 | [`Ax5f9sdD...`](https://testnet.nearblocks.io/txns/Ax5f9sdDaR2nqL3q3wDKq87FLbd7tVPUYeUnwmMQWToZ) | [by-tx](https://testnet-api.outlayer.ai/attestations/by-tx/Ax5f9sdDaR2nqL3q3wDKq87FLbd7tVPUYeUnwmMQWToZ) |
| S1 `prudentbot` vs `tft-oneshot` | C vs C | [`27E7LrmH...`](https://testnet.nearblocks.io/txns/27E7Lrmhj6qKDEQXjJZAcra85xixebyQLZFTZZCKtHQZ) | [by-tx](https://testnet-api.outlayer.ai/attestations/by-tx/27E7Lrmhj6qKDEQXjJZAcra85xixebyQLZFTZZCKtHQZ) |
| S6 `pool-guardian` vs `prudentbot` | C vs C | [`BdnREh6Q...`](https://testnet.nearblocks.io/txns/BdnREh6Qr3upnSMu3optbgc9UdzgWjymcnxQfwQVNDLD) | [by-tx](https://testnet-api.outlayer.ai/attestations/by-tx/BdnREh6Qr3upnSMu3optbgc9UdzgWjymcnxQfwQVNDLD) |

The two S1 matches were also spot-checked against OutLayer (`season-1/spot-check.json`: attestation ids 38012 and 38018):
executed WASM hash equals the pinned hash, `sig_a_ok` and `sig_b_ok` true, caller is the keeper account. Attestation URLs
were not re-fetched while writing this document.

## Strategy cards minted

Cards are multi-token (NEP-245) entries on `cards.osd.baldingsucks7993.testnet`, one per entry, plus a per-season badge token
(`badge:s<n>`, one unit per participant entry minted to its owner; S6 reports a supply of 20 for 25 cards, not investigated). Journals: `ops/runs/cards-season-<n>.jsonl`.

| Season | Cards | Badges | Mint tx |
|---|---|---|---|
| 1 | 10 | n/a | [`A9gJdVru...`](https://testnet.nearblocks.io/txns/A9gJdVruAVwvENNAPYg877fUp1mpdxPaTdo39n41ShKy) |
| 4 | 9 | 9 | [`5RU58Bx5...`](https://testnet.nearblocks.io/txns/5RU58Bx5HUJQgkCPE3ysZudkuLpyEoaAjmpHj7HWVjMb) |
| 6 | 25 | 20 (supply as reported by the mint tool) | [`BQWbxZrS...`](https://testnet.nearblocks.io/txns/BQWbxZrSgYjsVi5pGnTbF4agj7AtNA3jXETGLbTXSYhV), [`FrguedS2...`](https://testnet.nearblocks.io/txns/FrguedS2HEMGpgXNw71gkyCfDghCi5qbQJgqmJpEydtX) |

Checked with `mt_token`: `s4:fairbot...` is owned by `h20.baldingsucks7993.testnet` and `s6:prudentbot...` by `h22.baldingsucks7993.testnet`.
