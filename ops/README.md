# ops/ (WS6): build, deploy, secret, keeper, house agents, evidence

Everything here is **dry-run by default**. Scripts print the exact commands or transactions they would send and only sign with `--execute`. Read-only RPC views (account exists? `get_config`? keystore rows?) still run in dry-run.

Secrets are read only at runtime: signing keys from `~/.near-credentials/<network>/<account>.json` (near CLI legacy keychain) or `NEAR_PRIVATE_KEY`, `NEARAI_API_KEY` from the environment, and the OutLayer CLI login from `~/.outlayer`. Nothing secret is printed, logged or written inside the repo, except for commit salts under `ops/.state/` (gitignored, mode 0600).

| What | Command |
|---|---|
| Reproducible referee WASM | `ops/scripts/build-wasm.sh [out]`, or GitHub Actions **wasm-release** (manual) |
| FastFS upload + verify | `pnpm --filter @osd/ops fastfs-upload --file referee-wasm.wasm --version 1 --expect-sha256 <ci hash>` |
| Secret profile | `NEARAI_API_KEY=… ops/scripts/store-secret.sh --wasm-hash <hash> --near-credentials ~/.near-credentials/testnet/<contract>.json` (owner = the contract by default) |
| Point config at it (before seal, v6) | `near contract call-function as-transaction <contract> set_secrets json-args '{"owner":"<contract>","profile":"<p>"}' prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as <owner> …` (refused after seal) |
| Verify secret (read-only) | `ops/scripts/store-secret.sh --verify-only --wasm-hash <hash> [--profile p]` |
| Contract deploy + init | `ops/scripts/deploy.sh --wasm-url … --wasm-hash … --secrets-profile … --nearai-signer … [--max-agents 40 --seasons 1]` |
| Top up contract storage | `ops/scripts/deploy.sh --fund-only [--max-agents 40 --seasons 1]` |
| In-place code upgrade (testing only, state kept) | `ops/scripts/deploy.sh --redeploy …` / `ops/scripts/deploy-cards.sh --redeploy` |
| **Seal (one way, irreversible)** | `ops/scripts/seal.sh --contract osd.baldingsucks7993.testnet [--execute]`, same for `cards.osd…`: deletes every access key of the contract (from `view_access_key_list`), then checks `is_sealed()` and that the key list is `[]` (INTERFACE.md §6.4) |
| House agents (h01..h25) | `pnpm --filter @osd/ops house-agents --plan ../agents/plans/season-1.json` |
| House agents, pre-stage (before open) | `pnpm --filter @osd/ops house-agents --plan ../agents/plans/season-1.json --prestage --params season-params.fast-10.json` |
| Keeper (season runner) | `pnpm --filter @osd/ops keeper [--open season-params.example.json]` |
| Fast season (one command) | `pnpm --filter @osd/ops keeper --open season-params.fast-10.json --house-plan … --keys 15` (see [Fast seasons](#fast-seasons)) |
| Keeper on the mock contract | `pnpm --filter @osd/ops keeper --mock` / `--mock --plan --mock-at play` |
| Evidence export | `pnpm --filter @osd/ops export-evidence --season 1,2,3 [--fetch-tx]` / `--fixtures` |
| Tests / lint | `pnpm --filter @osd/ops test` / `lint` (tsc + shellcheck) |

Add `--execute` to any of these to send transactions. `pnpm --filter` runs each script inside `ops/`, so relative paths (`--plan`, `--open`, `--file`, `--runs-dir`) resolve from `ops/`: use `../agents/plans/…` for a WS-4 plan. The TypeScript runs directly on Node ≥ 22.6 (`--experimental-strip-types`), so there is no build step.

## P2 gate runbook (in order)

Every WASM rebuild produces a new hash. A new hash needs a new FastFS path, a new secret row and a new contract `wasm_hash`. Freeze the WASM first.

1. **Build:** in Actions, run **wasm-release** on `main` (set `release_tag` to e.g. `referee-wasm-v1` to publish a release). The job builds twice in fresh containers and fails if the hashes differ. **The CI sha256 is the hash you pin.** To re-derive it locally, run `ops/scripts/build-wasm.sh` (Docker, the same digest-pinned `rust:1.96.0` image, `linux/amd64`).
2. **Upload:** `fastfs-upload --file referee-wasm.wasm --version 1 --expect-sha256 <hash> --execute`. The URL is `https://test.fastfs.io/<sender>/outlayer.testnet/osd-referee/v<N>/<sha256>.wasm`. FastFS paths **can't be overwritten**: if a path already holds other bytes the tool says so, so bump `--version`. Files over 1 MiB go up as 1 MiB-aligned partial chunks. After upload the tool fetches the URL until the sha256 matches (indexer lag), then prints `WASM_URL` / `WASM_HASH`.
3. **Secret:** `NEARAI_API_KEY=… store-secret.sh --wasm-hash <hash> --near-credentials ~/.near-credentials/testnet/<contract>.json --execute` (or `outlayer login testnet` as the owner instead of `--near-credentials`). The **owner is the signer**: sign as the contract account (default `--owner`) so that `seal` also freezes the secrets; any other owner can re-store, re-scope or delete the profile after seal (attacks row 14, INTERFACE.md §6.4). `--near-credentials` copies the key into a temporary `OUTLAYER_HOME` that is deleted on exit. On an already-deployed contract, point the config at the new row with `set_secrets` (owner only, refused after seal); `seal.sh` warns if `secrets_owner ≠ contract`. This stores profile `osd-<hash12>` with `PROTECTED_SEASON_SEED` (hex32, generated in the TEE), `NEARAI_API_KEY`, accessor `WasmHash(<hash>)` and access `Predecessor{Whitelist[osd.baldingsucks7993.testnet]}` (`--via`, which reproduces the spike's `season1` row). It then checks the row through `outlayer.testnet::list_user_secrets`.
4. **Deploy:** `deploy.sh --wasm-url … --wasm-hash … --secrets-profile osd-<hash12> --nearai-signer <64 hex> --execute`. It builds the contract (`cargo near build non-reproducible-wasm --locked`), creates `osd.baldingsucks7993.testnet` under the parent, deploys, calls `new(...)` signed by `--owner` (default: the parent, which then opens seasons), and checks `get_config` field by field. It refuses to touch an initialised contract unless you pass `--redeploy`.
   **Storage:** the contract account pays for everything it stores (INTERFACE.md §6.1): ~4.3 KB per entry and ~0.7 KB per match, at 1 NEAR / 100 KB. A 40-agent season (40 entries, 780 matches) needs ≈ 7.2 NEAR, a 6-agent season < 0.4 NEAR; the code is ~3.5 NEAR. A new account is funded with code + `--seasons` × `--max-agents` + 1 NEAR margin (40 agents, 1 season: 11.68 NEAR). Past seasons' state stays, so before every new season run `deploy.sh --fund-only --max-agents N --execute`: it reads the free balance (`amount − storage_usage × 10¹⁹`) and sends only the shortfall from `--parent`.
5. **Season:** `keeper --open season-params.example.json --execute` (for short windows and a one-command season see [Fast seasons](#fast-seasons)). To pin a different referee for this season only (a rebuilt WASM, a new secret profile), add `--wasm-url … --wasm-hash …` (together) and/or `--secrets-profile …`; they go to `open_season` and are frozen in the season (`get_season.wasm`, `.secrets_profile`); the config defaults stay as deployed. Deadlines may be relative (`+2h`). The command opens the season and waits for `on_pubkey`. Run `house-agents --plan ../agents/plans/season-<n>.json --execute` during the commit window. The keeper then waits for the deadline, calls `close_commits` and `schedule_round` ×R, runs `play_match` for every pair, `refund_void`, and `settle_season`.
6. **Evidence:** `export-evidence --season 1 --fetch-tx` writes `ops/runs/evidence/<contract>/` (see below).

## Reproducible WASM build (`scripts/build-wasm.sh`, `.github/workflows/wasm-release.yml`)

- Image `rust:1.96.0-slim-bookworm@sha256:4732ca96…` (matches `wasm/referee/rust-toolchain.toml`; the script refuses if they drift), `--platform linux/amd64`.
- Sources are copied from a read-only mount to fixed paths (`/build`, `CARGO_HOME=/cargo`), then `cargo build --locked --release --target wasm32-wasip2`. Host paths and host `target/` never get in.
- Outputs: `referee-wasm.wasm`, `.sha256`, `build-info.json` (image digest, toolchain, git commit, dirty flag).
- The workflow runs on manual dispatch, and on PRs that touch the build inputs (artifact only). With `release_tag` it also publishes a GitHub release with the three files.

## Keeper (`src/keeper.ts`, CLI `src/cli/keeper.ts`)

It is a state machine over `get_season.status` that re-reads chain state before every step, so you can kill it and run it again at any point:

`open_season` (only if no season is active; otherwise it resumes the active one) → wait `pending_key` → (`--house-plan`: commit the house agents) → wait `commit_deadline_ns` (chain time) → `close_commits` → the remaining `schedule_round` calls, in parallel → sweep: `play_match` for each `scheduled` match (concurrency limit, default 15) and `refund_void` for each `void` match or each `pending` match older than 250 blocks → `settle_season` **as soon as** every match is `settled`/`refunded` (no wait for the play deadline), or after `play_deadline_ns` (the contract then voids anything unfinished).

Timing milestones go to the journal as `info/timing` records (`mark`: `opened`, `pubkey`, `commits_sent`, `closed`, `scheduled`, `all_final`, `settled`, each with `since_open_s` in chain time). Each tx record carries `key` (which keeper key signed it) when `--keys` is used.

**Batched settle (interfaces-v4).** After the play deadline `settle_season` voids at most 40 unfinished matches per call (100-log receipt limit) and returns `[]`; the keeper calls it again, with backoff, until it returns the ranking or the season reads `settled` (40 agents, nothing played: 780 matches → 20 calls, ~41 Tgas each). Capped by `--max-settle-calls` (32) per pass; the next pass carries on. Unpaid pool (prize rounding, unfilled slots) is the season's `carry_over_yocto` and is added to the next season's pool at `open_season` (`carry_in_yocto`).

**Gas** (per method, from the WS-1 sandbox measurements; same table as `@osd/sdk` `DEFAULT_GAS`): `register_agent` 50, `commit` 30, `claim` 30, `close_commits`/`refund_void`/`fund_agent`/`withdraw` 30, `schedule_round` 100, `play_match` 300 (the rest goes to OutLayer), `settle_season` 300, `open_season` 300 Tgas. `--gas-tgas` overrides it for every call.

**Idempotency, in layers:**
1. The contract is the source of truth: `play_match` is sent only for matches the view shows as `scheduled`. The contract also refuses anything else (one-shot rule).
2. A journal (`ops/runs/<season_id>.jsonl`, append-only, loaded on start) records every tx hash, including the `open_season` tx (written once the new season id is known; `keeper.jsonl` only holds season-less notes). A `play_match` that was included stays *in flight* for `graceBlocks` (10), so a lagging view never triggers a re-send. If the match is still `scheduled` after that, the tx failed on execution. It is re-sent with a warning, at most `maxSendsPerMatch` (2) times across runs.
3. Retries: transient errors (network, 429/5xx, timeouts, nonce) back off exponentially with jitter (1 s → 30 s, 5 attempts). **Before each retry the keeper re-reads state.** If the earlier attempt actually landed (for example a timeout after broadcast), it logs `skipped` and does not re-send. Contract refusals (`Smart contract panicked`, …) are never retried.
4. A void match is never re-played. It only gets `refund_void`.

Txs are sent with `waitUntil: INCLUDED_FINAL`. The OutLayer callback lands about 18 blocks later, which is longer than an RPC wait tolerates, so progress is followed through views. The keeper also logs `match_final` the first time it sees each result, which gives the wall-clock latency for the evidence.

Modes:
- **dry run** (default): one planning pass against the live RPC, read-only. It prints the calls it would make and writes the journal to `ops/runs/dryrun/`. Dry-run records (`outcome: dry_run`) never count as sends.
- `--execute`: signs as `--signer` (key from env or `~/.near-credentials`).
- `--mock`: a full season against the in-memory contract (`src/mock-chain.ts`) built from `interfaces/fixtures`, with no network. `--mock --plan --mock-at play` shows what a dry run prints for a season in play.

Journal records: `{ts, kind: tx|phase|info|warn|error, season_id, method, args, tx_hash, outcome: ok|refused|error|skipped|dry_run, attempt, block, signer, deposit_yocto, error?, retry_in_ms?}`. Plus `info/match_final` per match and `info/leaderboard` at the end.

## Fast seasons

The contract has no minimum window; the waits are settings and sequencing. Presets (unit 0.01 NEAR, bond 0.05 NEAR, as season 1):

| Preset | commit | play deadline | max_agents | entry deposit | for |
|---|---|---|---|---|---|
| `season-params.fast-attack.json` | `+2m` | `+10m` | 10 | 0.32 NEAR | WS-7 attack season (~6 agents, 15 matches) |
| `season-params.fast-10.json` | `+2m` | `+15m` | 10 | 0.32 NEAR | ≤ 10 agents (45 matches) |
| `season-params.fast-25.json` | `+2m` | `+60m` | 30 | 0.92 NEAR | S2 (25 + offspring) / S3 (30 agents, 435 matches) |

`max_agents` is a cap, not a count: the stake is fixed at `close_commits` from the real N and the excess of the entry deposit goes back to `claimable`.

**How the deadlines resolve** (`resolveOpenParams`, against chain time right before `open_season` is sent):
- A relative commit deadline (`+2m`, or `--commit-window 2m`) is a window **measured from pubkey arrival**. The deadline has to be absolute at `open_season`, before the key exists, so the keeper sets `commit_deadline = now + --pubkey-wait (45 s) + window`. `open_season → on_pubkey` measured 12 s (season 1) and 34 s (season 3), so a `+2m` window is ~2–2.5 min in practice; the keeper logs the effective window when the key lands and warns below 60 s.
- A relative play deadline (`+15m`) counts from open. It is only a ceiling: the keeper settles the moment no match is unfinished. Unfinished matches at the deadline are voided, so keep it ≥ 2 × the expected play time.

**Flow:**
1. Before opening (any time; no season key needed): `house-agents --plan <plan> --prestage --params season-params.fast-10.json --execute`. Creates/registers missing agents, `claim`s finished seasons' winnings into the agent budget, `fund_agent`s only the shortfall to the preset's entry deposit, and draws each agent's salt + commitment into `ops/.state/prestage/<contract>.json` (0600). At commit time only the ECIES encryption to the season key is left. A pre-staged salt is used once: it is deleted when its commit lands (a reused salt would link entries across seasons).
2. One command for the rest: `keeper --open season-params.fast-10.json --house-plan <plan> [--house-only a,b] [--house-season-plan-ok] --keys 15 --execute`. The keeper opens the season, and the moment the pubkey lands it commits every plan agent in parallel (≤ `--concurrency`; each owner signs its own commit, so owners never share a nonce), then waits for the deadline, closes, schedules all rounds in parallel, plays with 15 keys, refunds voids, settles as soon as nothing is unfinished. `--house-season-plan-ok` lets a plan written for another season (e.g. `season-1.seed.json`) be reused.
   Without `--house-plan`, run `house-agents --plan … --season current --wait-commit --execute` alongside the keeper: it polls each second for the commit phase and then commits in parallel.

**Parallel keeper signing (`--keys K`).** `play_match` attaches ≥ 0.02 NEAR for OutLayer, and NEAR **function-call access keys cannot attach a deposit**, so keys scoped to the osd methods cannot sign it. The keeper therefore adds K **full-access** keys to its own account, once, in a single AddKey tx signed by the main key, and keeps them next to it: `~/.near-credentials/<net>/keeper-keys/<signer>/k01.json … kNN.json` (0600, written *before* the AddKey tx). Later runs reuse them (only missing ones are added). Txs go round-robin to the next free key with at most `ceil(concurrency / (K+1))` in flight per key (1 with `--keys 15 --concurrency 15`), so each key's nonces are reserved and land in order: no nonce reuse, no "nonce must be larger" races. Remove them with `keeper --drop-keys --execute` (one DeleteKey tx, then the files are deleted). They are as powerful as the main key: keep the machine single-user.

**Expected timings** (season 1 measured: pubkey 12 s after open; `play_match` tx ~1 s to inclusion, OutLayer run p50 2.4 s, match final p50 73 s / p90 111 s / max 120 s after the play tx; mock tests assume a worse 4 s per tx, serial, and 189-block callbacks):

| Phase | fast-attack (6) | fast-10 (10) | fast-25 (25 / 30) |
|---|---|---|---|
| open → pubkey | 12–35 s | 12–35 s | 12–35 s |
| commit window (from open) | ~2.75 min | ~2.75 min | ~2.75 min |
| close + schedule (parallel) | < 10 s | < 10 s | < 15 s |
| play (15 keys) | ~2 min | ~2.5 min | ~6 / ~8 min if OutLayer runs 15 jobs at once (≥ 25 min if it serialises per payer) |
| settle | < 10 s after the last match | same | same |
| **total** | **~5 min** (deadline 10) | **~5–6 min** (deadline 15) | **~10–30 min** (deadline 60) |

**Live smoke (season 3, 2026-11-11, testnet):** `fast-10` preset, `--commit-window 2m`, 4 house agents (def-quarantine, tft-oneshot, prudentbot, coin-vowel; season-1 owners h08/h19/h22/h24, pre-staged: 2 claims + 1 fund_agent in 11 s), 6 matches, `--keys 15`. Journal: `runs/3.jsonl` (`info/timing`).

| Milestone | since open (chain time) |
|---|---|
| open_season landed | 0 s (tx 5.7 s before the first timing mark) |
| pubkey seen | 34 s (effective window 106 s with the old 30 s estimate → default now 45 s) |
| 4 commits sent (parallel, incl. reading chain facts) | +7 s → 42 s |
| close_commits | 146 s (right at the deadline) |
| 3 rounds scheduled (parallel) | 150 s |
| 6 play_match sent (6 different keeper keys, within 1 s) | 156 s |
| all 6 matches final | 226 s (65–70 s after the play txs) |
| settled (1 settle_season call) | 230 s |

**Total: 3 min 50 s from open to settle (4 min 6 s wall clock including the key setup); 0 voids, 6/6 settled.** Spent: keeper account 0.023 NEAR (15 AddKey + open + close + 3 schedule + 6 play deposits net of OutLayer refunds + settle); owners 0.0013 NEAR gas, plus 0.08 NEAR `fund_agent` now sitting in coin-vowel's budget. The smoke showed that the next pass re-sent `schedule_round` 3× because of view lag. They were refused, so nothing broke, but they burnt gas. The keeper now waits until the view shows every round before the next pass.

Before the smoke, season 2 (a stuck attack season, in `commit` past both deadlines, 9 entries) was closed and settled with no rounds scheduled, so every stake went back to `claimable` (`runs/2.jsonl`).

## House agents (`src/house.ts`, CLI `src/cli/house-agents.ts`)

This reads a WS-4 commit plan (`agents/plans/season-<n>.json`: `entries[] = {agent_id, name, family, parent, prompt_file, …}`). For entry *i* it uses owner `h<i+1, 2 digits>.<ops account>` (`h01.baldingsucks7993.testnet`, …). Each agent gets its own owner because the contract caps entries per owner (3) and ranks only against distinct owners.

The steps, each run only if missing (owner account / registered agent / committed entry are checked through views):
1. `create_owner`: a sub-account of the ops account, funded with `0.2 + entry_deposit + 0.1` NEAR (`--gas-margin`; the signer must hold the prepaid gas of `register_agent` 50 Tgas + `commit` 30 Tgas, ~0.08 NEAR, on top of the deposit, so 0.05 is refused with `NotEnoughBalance`). The full-access key is written to `~/.near-credentials/<net>/hNN.<ops>.json` *before* the tx.
2. `register_agent` from the owner: deposit `0.2 NEAR + entry_deposit_yocto`, so the budget covers the entry. The agent's function-call key (commit/claim) is saved like the owner key.
3. `claim` of finished seasons' `get_claimable` into the budget, then `fund_agent` for whatever is still short (existing agents only).
4. `commit` from the owner. The prompt is the strategy file body with the frontmatter removed and whitespace trimmed (same as `readStrategy(prompt_file).prompt`). It is sealed with `@osd/sdk` `sealPrompt` to `get_season.pubkey`. The salt goes to `ops/.state/salts/<contract>/season-<n>.json` *before* the tx (it is needed for `publish_prompt`).

An agent already registered by a different owner is skipped. With fixture params (`max_agents` 40, unit 0.01, bond 0.05), `entry_deposit` is 1.22 NEAR, so **25 owners need about 38 testnet NEAR**. Lower `max_agents`/`unit` to cut that; the excess stake is refunded to `claimable` at `close_commits`.

## Evidence export (`src/evidence.ts`, CLI `src/cli/export-evidence.ts`)

Sources: contract views (`get_season`, `get_entries`, `get_matches`, `get_leaderboard`), the keeper journal, optional `--events file` (NEP-297 lines) and optional `--fetch-tx` (`EXPERIMENTAL_tx_status` of every journaled tx, for gas and the OutLayer `execution_completed.payment_charged`/`time_ms`).

Output per season (`season-<n>/`):
- `matches.csv`: key, round, families, same-owner flag, status, moves, outcome, payoffs, pool delta, signature flags, void reason, blocks, latency, play tx
- `moves.csv`: one row per side (agent, family, opponent, move, payoff, same_owner)
- `families.csv`: agents, moves, C/D/F counts, coop rate, average payoff, best rank
- `summary.json`: counts by status, void reasons, coop / mutual-C / mutual-D rates, signature-ok rate, pool, stake, block-latency and keeper wall-clock latency stats, cost (gas, tokens burnt, OutLayer charge, per match), event counts, top 10

Across seasons: `seasons.csv`, `families.csv`. `export-evidence --fixtures` runs the same pipeline on `interfaces/fixtures`.

## Web tx index (`src/cli/export-tx-index.ts`)

`pnpm --filter @osd/ops export-tx-index [--runs-dir ops/runs] [--out tx-index.json]` reads the top-level keeper journals (not `dryrun/`/`mock/`) and writes `{"version":1,"tx":{"<season_id>:<a>:<b>":"<play_match tx hash>"}}` (last `outcome: ok` send per match wins). Host it and point the web's `NEXT_PUBLIC_INDEX_URL` at it; the web also accepts a raw `<season>.jsonl` journal directly.

## Strategy cards (WS-8: `scripts/deploy-cards.sh`, `src/cards.ts`, CLI `src/cli/mint-cards.ts`)

NEP-245 cards live in a separate contract (`contracts/cards`, `cards.osd.baldingsucks7993.testnet`); the
core contract is not touched. Both commands are dry runs unless `--execute`.

```sh
ops/scripts/deploy-cards.sh [--execute]                    # create cards.<core> (signed by core), fund from parent, deploy + new()
pnpm --filter @osd/ops mint-cards --season 1 [--execute]  # settled season -> mint_season_cards (skips minted cards)
```

`mint-cards` reads `get_season` (must be settled), `get_leaderboard` and `get_entries`; family comes from the
house plan (`agents/plans/season-<n>[.seed].json`), else the committed entry family, else `unknown`; `settle_tx`
from `runs/<n>.jsonl`. Token ids: card `s<n>:<agent_id>` (supply 1, to the entry owner), badge `badge:s<n>`
(one unit per entry). Sent txs are journaled to `runs/cards-season-<n>.jsonl`.

## Other pieces

- `fastfs/`: the spike's Python payload tools (reference). `src/fastfs.ts` is the TS port; a test checks the payload layout byte for byte, and its output matches `fastfs_payload.py` exactly on the referee WASM.
- `src/secrets.ts` / `verify-secret`: reads keystore metadata (no values) and checks profile, `WasmHash`, and a Predecessor whitelist of exactly `[contract]` with no `AllowAll`.
- `src/rpc.ts`: a minimal JSON-RPC client with injectable `fetch` (the tests use a mock RPC). `src/near-chain.ts`: signing through `near-api-js` 7.4.0; decodes the call's `SuccessValue` (used for `settle_season`'s `[]` vs ranking).

## Known caveats

- `outlayer secrets set` takes the secret JSON only as a command-line argument, so `NEARAI_API_KEY` is visible in the process list for the few seconds the command runs. Run it on a single-user machine.
- `deploy.sh` deploys and then calls `new` in a separate tx, so that `--owner` (not the contract account) becomes owner. Someone could front-run `new` in that window; the `get_config` owner check catches it (redeploy to a fresh account if it happens).
- Without `--keys`, concurrent txs from one signer share one access key: `near-api-js` reserves nonces locally, and an out-of-order landing gives `InvalidNonce`, which is retried. With `--keys K` each key carries one tx at a time (see [Fast seasons](#fast-seasons)).
- `--house-plan`/`--wait-commit` agents run in parallel, but one agent's steps stay in order; a failed step stops only that agent (re-run to resume).
- The free fastnear testnet RPC rate-limits bursts (HTTP 429): 30 parallel house commits lost a whole season once (season 5 cancelled with 0 entries). Every house tx now retries transient errors (8 attempts, 1 s → 10 s; a retried commit refused with `agent already entered` counts as landed), and `NearRpc` retries 429/5xx 10 times (backoff capped at 15 s). `rpc.testnet.near.org` is deprecated and answers 429 to everything.
- The contract build uses `non-reproducible-wasm`, because `contracts/dilemma/Cargo.toml` has no `[package.metadata.near.reproducible_build]` section (WS1's directory).
