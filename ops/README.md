# ops/ (WS6): build, deploy, secret, keeper, house agents, evidence

Everything here is **dry-run by default**. Scripts print the exact commands or transactions they would send and only sign with `--execute`. Read-only RPC views (account exists? `get_config`? keystore rows?) still run in dry-run.

Secrets are read only at runtime: signing keys from `~/.near-credentials/<network>/<account>.json` (near CLI legacy keychain) or `NEAR_PRIVATE_KEY`, `NEARAI_API_KEY` from the environment, and the OutLayer CLI login from `~/.outlayer`. Nothing secret is printed, logged or written inside the repo, except for commit salts under `ops/.state/` (gitignored, mode 0600).

| What | Command |
|---|---|
| Reproducible referee WASM | `ops/scripts/build-wasm.sh [out]`, or GitHub Actions **wasm-release** (manual) |
| FastFS upload + verify | `pnpm --filter @osd/ops fastfs-upload --file referee-wasm.wasm --version 1 --expect-sha256 <ci hash>` |
| Secret profile | `NEARAI_API_KEY=… ops/scripts/store-secret.sh --wasm-hash <hash>` |
| Verify secret (read-only) | `ops/scripts/store-secret.sh --verify-only --wasm-hash <hash> [--profile p]` |
| Contract deploy + init | `ops/scripts/deploy.sh --wasm-url … --wasm-hash … --secrets-profile … --nearai-signer …` |
| House agents (h01..h25) | `pnpm --filter @osd/ops house-agents --plan agents/plans/season-1.json` |
| Keeper (season runner) | `pnpm --filter @osd/ops keeper [--open ops/season-params.example.json]` |
| Keeper on the mock contract | `pnpm --filter @osd/ops keeper --mock` / `--mock --plan --mock-at play` |
| Evidence export | `pnpm --filter @osd/ops export-evidence --season 1,2,3 [--fetch-tx]` / `--fixtures` |
| Tests / lint | `pnpm --filter @osd/ops test` / `lint` (tsc + shellcheck) |

Add `--execute` to any of these to send transactions. The TypeScript runs directly on Node ≥ 22.6 (`--experimental-strip-types`), so there is no build step.

## P2 gate runbook (in order)

Every WASM rebuild produces a new hash. A new hash needs a new FastFS path, a new secret row and a new contract `wasm_hash`. Freeze the WASM first.

1. **Build:** in Actions, run **wasm-release** on `main` (set `release_tag` to e.g. `referee-wasm-v1` to publish a release). The job builds twice in fresh containers and fails if the hashes differ. **The CI sha256 is the hash you pin.** To re-derive it locally, run `ops/scripts/build-wasm.sh` (Docker, the same digest-pinned `rust:1.96.0` image, `linux/amd64`).
2. **Upload:** `fastfs-upload --file referee-wasm.wasm --version 1 --expect-sha256 <hash> --execute`. The URL is `https://test.fastfs.io/<sender>/outlayer.testnet/osd-referee/v<N>/<sha256>.wasm`. FastFS paths **can't be overwritten**: if a path already holds other bytes the tool says so, so bump `--version`. Files over 1 MiB go up as 1 MiB-aligned partial chunks. After upload the tool fetches the URL until the sha256 matches (indexer lag), then prints `WASM_URL` / `WASM_HASH`.
3. **Secret:** `outlayer login testnet` (as the secrets owner), then `NEARAI_API_KEY=… store-secret.sh --wasm-hash <hash> --execute`. This stores profile `osd-<hash12>` with `PROTECTED_SEASON_SEED` (hex32, generated in the TEE), `NEARAI_API_KEY`, accessor `WasmHash(<hash>)` and access `Predecessor{Whitelist[osd.baldingsucks7993.testnet]}` (`--via`, which reproduces the spike's `season1` row). It then checks the row through `outlayer.testnet::list_user_secrets`.
4. **Deploy:** `deploy.sh --wasm-url … --wasm-hash … --secrets-profile osd-<hash12> --nearai-signer <64 hex> --execute`. It builds the contract (`cargo near build non-reproducible-wasm --locked`), creates `osd.baldingsucks7993.testnet` under the parent, deploys, calls `new(...)` signed by `--owner` (default: the parent, which then opens seasons), and checks `get_config` field by field. It refuses to touch an initialised contract unless you pass `--redeploy`.
5. **Season:** `keeper --open ops/season-params.example.json --execute`. Deadlines may be relative (`+2h`). The command opens the season and waits for `on_pubkey`. Run `house-agents --plan … --execute` during the commit window. The keeper then waits for the deadline, calls `close_commits` and `schedule_round` ×R, runs `play_match` for every pair, `refund_void`, and `settle_season`.
6. **Evidence:** `export-evidence --season 1 --fetch-tx` writes `ops/runs/evidence/<contract>/` (see below).

## Reproducible WASM build (`scripts/build-wasm.sh`, `.github/workflows/wasm-release.yml`)

- Image `rust:1.96.0-slim-bookworm@sha256:4732ca96…` (matches `wasm/referee/rust-toolchain.toml`; the script refuses if they drift), `--platform linux/amd64`.
- Sources are copied from a read-only mount to fixed paths (`/build`, `CARGO_HOME=/cargo`), then `cargo build --locked --release --target wasm32-wasip2`. Host paths and host `target/` never get in.
- Outputs: `referee-wasm.wasm`, `.sha256`, `build-info.json` (image digest, toolchain, git commit, dirty flag).
- The workflow runs on manual dispatch, and on PRs that touch the build inputs (artifact only). With `release_tag` it also publishes a GitHub release with the three files.

## Keeper (`src/keeper.ts`, CLI `src/cli/keeper.ts`)

It is a state machine over `get_season.status` that re-reads chain state before every step, so you can kill it and run it again at any point:

`open_season` (only if no season is active; otherwise it resumes the active one) → wait `pending_key` → wait `commit_deadline_ns` (chain time) → `close_commits` → `schedule_round` until `rounds_scheduled == total_rounds` → sweep: `play_match` for each `scheduled` match (concurrency limit, default 4) and `refund_void` for each `void` match or each `pending` match older than 250 blocks → `settle_season` once every match is `settled`/`refunded`, or after `play_deadline_ns` (the contract then voids anything unfinished).

**Idempotency, in layers:**
1. The contract is the source of truth: `play_match` is sent only for matches the view shows as `scheduled`. The contract also refuses anything else (one-shot rule).
2. A journal (`ops/runs/<season_id>.jsonl`, append-only, loaded on start) records every tx hash. A `play_match` that was included stays *in flight* for `graceBlocks` (10), so a lagging view never triggers a re-send. If the match is still `scheduled` after that, the tx failed on execution. It is re-sent with a warning, at most `maxSendsPerMatch` (2) times across runs.
3. Retries: transient errors (network, 429/5xx, timeouts, nonce) back off exponentially with jitter (1 s → 30 s, 5 attempts). **Before each retry the keeper re-reads state.** If the earlier attempt actually landed (for example a timeout after broadcast), it logs `skipped` and does not re-send. Contract refusals (`Smart contract panicked`, …) are never retried.
4. A void match is never re-played. It only gets `refund_void`.

Txs are sent with `waitUntil: INCLUDED_FINAL`. The OutLayer callback lands about 18 blocks later, which is longer than an RPC wait tolerates, so progress is followed through views. The keeper also logs `match_final` the first time it sees each result, which gives the wall-clock latency for the evidence.

Modes:
- **dry run** (default): one planning pass against the live RPC, read-only. It prints the calls it would make and writes the journal to `ops/runs/dryrun/`. Dry-run records (`outcome: dry_run`) never count as sends.
- `--execute`: signs as `--signer` (key from env or `~/.near-credentials`).
- `--mock`: a full season against the in-memory contract (`src/mock-chain.ts`) built from `interfaces/fixtures`, with no network. `--mock --plan --mock-at play` shows what a dry run prints for a season in play.

Journal records: `{ts, kind: tx|phase|info|warn|error, season_id, method, args, tx_hash, outcome: ok|refused|error|skipped|dry_run, attempt, block, signer, deposit_yocto, error?, retry_in_ms?}`. Plus `info/match_final` per match and `info/leaderboard` at the end.

## House agents (`src/house.ts`, CLI `src/cli/house-agents.ts`)

This reads a WS-4 commit plan (`agents/plans/season-<n>.json`: `entries[] = {agent_id, name, family, parent, prompt_file, …}`). For entry *i* it uses owner `h<i+1, 2 digits>.<ops account>` (`h01.baldingsucks7993.testnet`, …). Each agent gets its own owner because the contract caps entries per owner (3) and ranks only against distinct owners.

The steps, each run only if missing (owner account / registered agent / committed entry are checked through views):
1. `create_owner`: a sub-account of the ops account, funded with `0.2 + entry_deposit + 0.05` NEAR. The full-access key is written to `~/.near-credentials/<net>/hNN.<ops>.json` *before* the tx.
2. `register_agent` from the owner: deposit `0.2 NEAR + entry_deposit_yocto`, so the budget covers the entry. The agent's function-call key (commit/claim) is saved like the owner key.
3. `fund_agent` only if an existing agent's budget is short.
4. `commit` from the owner. The prompt is the strategy file body with the frontmatter removed and whitespace trimmed (same as `readStrategy(prompt_file).prompt`). It is sealed with `@osd/sdk` `sealPrompt` to `get_season.pubkey`. The salt goes to `ops/.state/salts/<contract>/season-<n>.json` *before* the tx (it is needed for `publish_prompt`).

An agent already registered by a different owner is skipped. With fixture params (`max_agents` 40, unit 0.01, bond 0.05), `entry_deposit` is 1.22 NEAR, so **25 owners need about 36.75 testnet NEAR**. Lower `max_agents`/`unit` to cut that; the excess stake is refunded to `claimable` at `close_commits`.

## Evidence export (`src/evidence.ts`, CLI `src/cli/export-evidence.ts`)

Sources: contract views (`get_season`, `get_entries`, `get_matches`, `get_leaderboard`), the keeper journal, optional `--events file` (NEP-297 lines) and optional `--fetch-tx` (`EXPERIMENTAL_tx_status` of every journaled tx, for gas and the OutLayer `execution_completed.payment_charged`/`time_ms`).

Output per season (`season-<n>/`):
- `matches.csv`: key, round, families, same-owner flag, status, moves, outcome, payoffs, pool delta, signature flags, void reason, blocks, latency, play tx
- `moves.csv`: one row per side (agent, family, opponent, move, payoff, same_owner)
- `families.csv`: agents, moves, C/D/F counts, coop rate, average payoff, best rank
- `summary.json`: counts by status, void reasons, coop / mutual-C / mutual-D rates, signature-ok rate, pool, stake, block-latency and keeper wall-clock latency stats, cost (gas, tokens burnt, OutLayer charge, per match), event counts, top 10

Across seasons: `seasons.csv`, `families.csv`. `export-evidence --fixtures` runs the same pipeline on `interfaces/fixtures`.

## Other pieces

- `fastfs/`: the spike's Python payload tools (reference). `src/fastfs.ts` is the TS port; a test checks the payload layout byte for byte, and its output matches `fastfs_payload.py` exactly on the referee WASM.
- `src/secrets.ts` / `verify-secret`: reads keystore metadata (no values) and checks profile, `WasmHash`, and a Predecessor whitelist of exactly `[contract]` with no `AllowAll`.
- `src/rpc.ts`: a minimal JSON-RPC client with injectable `fetch` (the tests use a mock RPC). `src/near-chain.ts`: signing through `near-api-js` 7.4.0. TODO: switch views to `@osd/sdk` once WS3 lands.

## Known caveats

- `outlayer secrets set` takes the secret JSON only as a command-line argument, so `NEARAI_API_KEY` is visible in the process list for the few seconds the command runs. Run it on a single-user machine.
- `deploy.sh` deploys and then calls `new` in a separate tx, so that `--owner` (not the contract account) becomes owner. Someone could front-run `new` in that window; the `get_config` owner check catches it (redeploy to a fresh account if it happens).
- Many concurrent txs from one signer share one access key. `near-api-js` manages nonces, and `InvalidNonce` is retried. If throughput needs it, add more keys to the signer.
- The contract build uses `non-reproducible-wasm`, because `contracts/dilemma/Cargo.toml` has no `[package.metadata.near.reproducible_build]` section (WS1's directory).
