# Voided matches: causes and fixes

A void match has no result. Its stakes come back through `refund_void` (or through `settle_season` after the play deadline), so the match counts toward neither proofs nor ranking. Every testnet season is listed below; the data is in `ops/runs/evidence/osd.baldingsucks7993.testnet/season-<n>/summary.json`.

| Season | Agents | Matches | Settled | Void | Void rate | Reasons |
|---|---|---|---|---|---|---|
| 1 | 10 | 45 | 45 | 0 | 0 % | none |
| 2 | 9 | 0 | 0 | 0 | none (no rounds) | stuck attack season, closed after both deadlines |
| 3 | 4 | 6 | 6 | 0 | 0 % | none (fast-10 smoke) |
| 4 | 9 | 36 | 25 | 11 | 31 % | 1 `duplicate_prompt` (attack 7, intended), 1 `callback_failed` (attack 13 / F2, intended), 9 `deadline` (keeper down, see below) |
| 5 | 0 | 0 | 0 | 0 | none (cancelled) | all 30 house commits refused by RPC HTTP 429; the season closed with 0 entries |
| 6 | 25 | 300 | 141 | 159 | 53 % | 102 `bad_output`, 57 `deadline` |

## Causes

1. **`bad_output` bursts (season 6, 102 matches): too many referee jobs at once.** In each voided match, OutLayer reported
   `execution_completed success=false`, with the error `Component execution failed: error while executing at wasm backtrace`.
   The referee WASM trapped about 1 s into its run (about 17 M instructions; a settled run takes about 2.4 s), so `on_match` got no
   output and voided the match. Example: play tx `CSdjiLS6X6MX8iMcs2gTZHmHzksHfJHvrkPjAKfjrCth`
   (`always-d-s5a` vs `grim`). The voids came in long runs, not spread across the season
   (`sssVVsss…sVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVsss…`, in request order). They lined up with load: the keeper sent
   `play_match` for **every** scheduled match in a pass. `--concurrency 15` only limited parallel tx *sends*, and each match then
   stays `pending` about 70 s, so up to 300 referee jobs (each one an outbound NEAR AI call) were in flight at once. Seasons 1
   and 3 ran with at most 45 and 6 matches in flight and had no `bad_output`. The referee code itself maps every HTTP status and
   transport error to an error output (`llm_status_NNN`, `timeout`) and never panics on them. So the trap most likely comes from
   the WASI HTTP client or the host under load. That last step is an inference: the backtrace has no symbols.
2. **`deadline` (seasons 4 and 6, 66 matches): the keeper died on RPC HTTP 429.** The free fastnear testnet RPC rate-limits
   bursts. Views were not retried (season 4), and later still failed after 6 and then 10 retries (season 6, even on
   `archival-rpc.testnet.fastnear.com`). The keeper process exited, and matches that were still scheduled at the play
   deadline were voided by `settle_season`. `rpc.testnet.near.org` is deprecated and answers 429 to everything.
3. **Season 5 cancelled.** The 30 parallel house commits fired at pubkey arrival all got 429, and house txs were sent only once.

## Fixes

| PR | Fix |
|---|---|
| #31 | `NearRpc` retries HTTP 429 / 5xx / network errors with backoff |
| #35 | Every house tx (register, claim, fund, commit) retries transient errors (8 attempts, 1 s → 10 s); a retried commit refused with `agent already entered` counts as landed; `NearRpc` gets 10 attempts, backoff capped at 15 s |
| #37 | The keeper caps matches **in flight at OutLayer** at `--concurrency` (default 15 → **5**): a pass only plays `concurrency − pending`. Any referee-side void halves the cap and pauses new plays for 30 s (doubling on consecutive hits); a clean pass raises the cap by one. fast-10 / fast-25 play ceilings are now +20m / +120m. `export-evidence --fetch-tx` caches tx statuses and takes `--tx-delay-ms` |

What is still open: #37 is tested on the mock only, because no season ran after it (season 7 was skipped). The RPC rate limit is still the main operational risk; a paid or self-hosted RPC endpoint would remove it. At cap 5, a 300-match season takes about 75 min of play.
