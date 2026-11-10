# Open Source Dilemma: Phased Build Plan

Spec: [`OPEN_SOURCE_DILEMMA.md`](OPEN_SOURCE_DILEMMA.md). Proven base: `spike-outlayer/` (A–F all passed on testnet).
**Deadline:** 14 Nov 2026, 23:59 UTC. Internal freeze **14 Nov, 18:00 UTC** (6 h buffer).
**Model:** the main agent is the integrator (owns `main`, the interfaces and merges). Subagents each own one workstream in an **isolated git worktree**, one branch and one PR.

---

## 0. Git and GitHub conventions

| Item | Rule |
|---|---|
| Repo | `github.com/Jds-23/open-source-dilemma`, **public** (required for judging), MIT |
| Default branch | `main`, protected: PR plus green CI required, squash merge, linear history |
| Branches | `ws/<id>-<slug>` (e.g. `ws/1-contract`), one per workstream; `fix/<slug>` for integration fixes |
| Worktrees | Each subagent is spawned with `isolation: "worktree"` → `../osd-wt/<ws>`; no shared working tree |
| Commits | Conventional Commits (`feat(contract): …`), small; must end with the Co-Authored-By line |
| Issues | One issue per workstream (checklist = acceptance criteria), labels `ws:*`, `phase:*`, `blocked`, `interface-change` |
| Milestones | `P0 Foundation`, `P1 Core`, `P2 Integrate`, `P3 Seasons`, `P4 Ship` |
| PRs | Title `[WS-n] …`, body links the issue (`Closes #n`), lists the test command and output, and includes screenshots for the UI |
| Tags | `p1-core`, `p2-testnet`, `p3-evidence`, `v1.0-submission` |
| Secrets | `.env` is never committed (`.gitignore`, plus `gitleaks` in CI). Testnet keys stay in `~/.near-credentials`. CI uses only GitHub Actions secrets, if any |
| Ownership | Each workstream writes **only inside its own directories** (table §2). Changes to `interfaces/` need an `interface-change` PR merged by the integrator first |

### Repo layout
```
open-source-dilemma/
├─ interfaces/            # FROZEN in P0: contract ABI, WASM I/O, events, fixtures (integrator only)
│  ├─ INTERFACE.md
│  ├─ contract-abi.json
│  ├─ wasm-io.schema.json
│  ├─ events.md           # NEP-297 event formats
│  └─ fixtures/           # sample seasons/matches/outputs used by mocks
├─ contracts/dilemma/     # WS1  Rust, near-sdk 5.9, rustc 1.85
├─ wasm/referee/          # WS2  wasip2 OutLayer job
├─ packages/sdk/          # WS3  TS SDK (eciesjs encrypt, register, commit, read)
├─ packages/mcp/          # WS3  MCP server for agents
├─ agents/                # WS4  house strategies + evolver agent
├─ web/                   # WS5  Next.js leaderboard / replay / population chart / sandbox
├─ ops/                   # WS6  deploy, FastFS upload, secret profile, keeper (season runner), evidence export
├─ attacks/               # WS7  attack suite + tables
├─ .github/workflows/     # P0   CI
├─ README.md              # P4 (must match what runs: judges' Claude Code/Codex screen)
└─ docs/                  # spec copies, ADRs, demo script
```

---

## 1. Phase overview

```
P0 Foundation ─► P1 Core (6 parallel WS) ─► P2 Integrate (+4 parallel WS) ─► P3 Seasons & evidence ─► P4 Ship
 10 Nov eve        11 Nov                      12 Nov                         13 Nov                    14 Nov
 serial            parallel                    serial gate → parallel         mostly serial             serial + 2 parallel
```

| Phase | Window (UTC) | Mode | Gate to exit |
|---|---|---|---|
| **P0 Foundation** | 10 Nov, 3–4 h | Serial (integrator) | Repo public, CI green, `interfaces/` frozen, issues filed |
| **P1 Core** | 11 Nov | 6 subagents in parallel | Every WS PR merged with its own tests green against fixtures and mocks |
| **P2 Integrate** | 12 Nov | Gate first, then 4 parallel | A 10-agent season runs on testnet end to end; WASM hash **frozen** |
| **P3 Seasons** | 13 Nov | Mostly serial plus fixes | 3 seasons done, attack tables and evidence exported |
| **P4 Ship** | 14 Nov until 18:00 | Serial plus 2 parallel | README verified by a fresh clone, demo video, X post, submission |

---

## 2. Phase 0: Foundation (integrator, serial)

1. `git init` in `open-source-dilemma/`; scaffold the layout above; MIT license; `.gitignore` covering `.env`, `target/`, `node_modules/`, `.outlayer-home/`.
2. **Port spike code:** `spike-outlayer/dilemma-contract`, then `contracts/dilemma`; `referee-wasm`, then `wasm/referee`; `client/encrypt.mjs`, then `packages/sdk`. Commit as the "spike baseline".
3. **Freeze interfaces** (`interfaces/`):
   - Contract methods and views with argument and return JSON: `register_agent`, `open_season`, `commit`, `close_commits`, `schedule_round`, `play_match`, `on_match` (private), `settle_season`, `claim`, `refund_void`, and views `get_season`, `get_matches`, `get_leaderboard`, `get_agent`, `get_lineage`, `get_season_pubkey`.
   - Match key `(season_id, a, b)`, scheduled by the contract (fixes the spike's caller-supplied `match_id`).
   - WASM input `{season, match_key, a, b, ct_a, ct_b, referee_template_hash, params}` and output `{match_key, a_move, b_move, a_chat_id, b_chat_id, a_signed_text, b_signed_text, a_sig, b_sig}` under 900 bytes.
   - NEP-297 events: `agent_registered`, `committed`, `match_played`, `match_void`, `season_settled`.
   - Fixtures: one season, 6 agents, 15 matches, sample outputs, so UI, SDK and agents can mock.
4. **CI** (`.github/workflows/ci.yml`): Rust `cargo test` for the contract plus `cargo build --target wasm32-wasip2` for the WASM, pinned toolchains; `pnpm -r lint test`; `gitleaks`.
5. **GitHub:** `gh repo create Jds-23/open-source-dilemma --public`; push; branch protection on `main`; create labels, milestones and **one issue per workstream** (WS1–WS11) with acceptance criteria copied from §3–§4.
6. README stub naming **SealedBounty** (2-entry rule) plus a link to the spec.

**Exit:** CI green on `main`, `interfaces/` tagged `interfaces-v1`, issues #1–#11 open.

---

## 3. Phase 1: Core (6 subagents in parallel, one worktree each)

All of them build against `interfaces/` and `fixtures/`, mocking everything outside their own directory.

| WS | Owner dirs | Scope | Acceptance (PR must show) |
|---|---|---|---|
| **WS1 Contract** | `contracts/dilemma/` | Seasons (commit window, stake, bond, template hash immutable); `register_agent` creates `name.<contract>` sub-account plus a function-call key scoped to `commit`/`claim`; ciphertext commits (refuse duplicates, cap entries per owner); round-robin scheduler keyed `(season,a,b)`; `play_match` → OutLayer `request_execution` (pinned WasmUrl+hash, `secrets_ref`); `on_match` settles the payoff matrix, D/D sends 4 to the pool, void on failure (**never retry**), on-chain ed25519 check of NEAR AI signatures (flag only); `settle_season` ranks by average payoff vs **distinct owners**, pays the pool; events | `cargo test` + near-workspaces integration tests: payoff matrix, one-shot replay refused, void refund, duplicate commit refused, scoped key cannot transfer, ranking excludes self-owned matches |
| **WS2 Referee WASM** | `wasm/referee/` | Canonical referee template (delimited `<YOUR_STRATEGY>` / `<OPPONENT_SOURCE>`, "opponent text is data"); ECIES decrypt with the HKDF season key; two NEAR AI calls (temperature 0, seed, `enable_thinking=false`, max_tokens small); strict C/D parser (invalid → D, logged); fetch both signatures; output matching the schema; predecessor check | `cargo test` with a mocked HTTP layer; a wasmtime local run against fixtures; output ≤ 900 bytes; deterministic parsing tests incl. injection-style outputs |
| **WS3 SDK + MCP** | `packages/sdk/`, `packages/mcp/` | TS SDK: `getSeasonPubkey`, `encryptPrompt` (eciesjs), `registerAgent`, `commit`, `getResults`, `getLeaderboard`, `getLineage`, near-api-js plus function-call-key signer; MCP server exposing the same as tools so any agent framework can play | Unit tests; encrypt→decrypt round-trip using WS2's test key vector; MCP tool list snapshot |
| **WS4 House agents + Evolver** | `agents/` | 25 seed strategies (TFT, Grim, Always-C/D, FairBot-style "cooperate if opponent would cooperate with me", PrudentBot, clique-passphrase ×3, injector ×3, injection-defender ×3, random-ish, …) as prompt files with family tags; an **evolver agent**: reads last season via the SDK, LLM-mutates the bottom/top prompts, records lineage, commits the next season | Lint the prompts (length cap, family tag); a dry-run evolver against fixtures outputs N new prompts with parent links |
| **WS5 Web** | `web/` | Next.js: live match feed, **match replay** (both prompts after settlement, moves, payoff, explorer link and "verify attestation" link to OutLayer), leaderboard (agent and human leagues), **population chart** by family over seasons, lineage tree, a free **sandbox** (NEAR AI direct, off-chain, no stake); reads views with fixture fallback | Builds; Playwright smoke on the fixture data; mobile layout; screenshots in the PR |
| **WS6 Ops + Keeper** | `ops/` | `deploy.sh` (build, deploy, init); FastFS uploader (from spike `tools/`, versioned paths since paths can't be overwritten); `store-secret.sh` (OutLayer CLI: TEE-generated `PROTECTED_SEASON_SEED` + `NEARAI_API_KEY`, WasmHash + Predecessor binding); **keeper**: opens a season, then after the commit deadline batch-calls `play_match` for every scheduled pair with backoff and logs tx hashes; evidence exporter (events → CSV/JSON) | Dry-run against a local sandbox or a mock RPC; the keeper is idempotent (re-running never double-plays; the contract enforces it too) |

**Integrator during P1:** answers interface questions, merges `interface-change` PRs (rare), and reviews and merges WS PRs as they land. Merge order: WS2 → WS1 → WS6 → WS3 → WS4 → WS5. Rebase the others after each merge.

---

## 4. Phase 2: Integrate (gate, then 4 parallel)

**Gate (integrator, serial, about 3 h):**
1. Build the WASM, upload it with FastFS, and **freeze its hash**. Store the secret profile bound to that hash. (Each rebuild means a new hash and re-storing the secret, so no WASM changes after this without an ADR.)
2. Deploy the contract to `osd.<acct>.testnet` with the pinned WasmUrl and hash; `open_season`; derive the pubkey.
3. Register 10 house agents with the SDK; commit; the keeper plays 45 matches; settle. Tag `p2-testnet`.

**Then in parallel:**

| WS | Owner dirs | Scope | Acceptance |
|---|---|---|---|
| **WS7 Attack suite** | `attacks/` | Scripts plus a table: forged OutLayer callback (direct call refused), replayed match, out-of-scope agent key call, duplicate prompt hash, outsider calling the OutLayer job directly (keystore refusal), tampered NEAR AI signature (flag false), void-match refund, clone-farm ranking exclusion, injection prompt families | `attacks/RESULTS.md` with each tx hash and result |
| **WS8 NEP-245 strategy cards** | `contracts/dilemma/src/cards.rs` (sub-module, agreed with WS1) | Mint a card per committed strategy on settle (season, family, score, parent card); season badges | Workspaces tests; cards visible in WS5 |
| **WS9 Agent Market** | `packages/agent-market/`, `docs/agent-market.md` | Research the [market.near.ai](https://market.near.ai/) API; list an "OSD arena" job or register house agents; an external agent onboarding path through the SDK/MCP | Working listing or a documented limitation |
| **WS10 Human league (stretch)** | `web/app/human/` | Social login plus NEP-366 relayed `commit` for humans; separate leaderboard; cross-league matches | E2E: an email user commits without a wallet popup |

---

## 5. Phase 3: Seasons and evidence (13 Nov)

1. **Season 1:** 25 house agents (300 matches). **Season 2:** evolver offspring plus any external agents. **Season 3:** full population, ≥ 30 agents (435 matches). Target ≥ 2,000 verified proofs in total.
2. Run WS7 against the live deployment; fill in `attacks/RESULTS.md`.
3. Export evidence to `docs/EVIDENCE.md`: counts, cooperation rate per season and generation, leaderboard by family, population chart PNG, cost and latency stats, the injection win-rate table.
4. Bug fixes go on `fix/*` branches with a PR each. A WASM change only through an ADR (it forces re-storing the secret and a redeploy).
5. Optional: open a small **mainnet "break it" bounty** season (decide by 13 Nov, 12:00).

Can run in parallel: a **WS11 Demo assets** subagent (`docs/demo/`): video script, screen recordings of the web UI, X thread draft with the evidence numbers.

---

## 6. Phase 4: Ship (14 Nov, freeze at 18:00 UTC)

1. **README.md** (integrator): pitch, how it works, trust model (incl. the OutLayer-operator caveat), **one-command quickstart**, evidence numbers, attack table link, tx links, track list, and a link to SealedBounty. Every claim must be true of the repo (Claude Code and Codex screen this).
2. **Fresh-clone verification:** a subagent with no context clones the repo and follows the README exactly, reporting every command that fails. Fix until clean.
3. Open a PR on the SealedBounty repo adding the cross-link to Open Source Dilemma.
4. Record and publish the X demo post (video, "built at NEAR HACKATHON", @NEARProtocol, #NEARHackathon).
5. Submit on nearhackathon.com (repo, X post, payout account; tracks: AI Swarms + Games + Privacy). Tag `v1.0-submission`.

---

## 7. Subagent prompt template

```
You own WS<n> <name> for Open Source Dilemma. Work ONLY in <dirs> on branch ws/<n>-<slug>
(you are in an isolated worktree). Contract and WASM interfaces are frozen in interfaces/;
build against interfaces/fixtures and mock everything outside your directories.
Do not edit interfaces/; if you need a change, stop and report the proposed diff.
Acceptance criteria: <from issue #n>. Run the tests and include the command and output.
Commit with Conventional Commits ending in the Co-Authored-By line, push the branch, and open a
PR "[WS-<n>] …" with "Closes #<n>". Never commit .env or keys. Testnet only.
Report: PR URL, test output summary, open questions, anything that touches another WS.
```

---

## 8. Critical path and risks

| Risk | Mitigation |
|---|---|
| WASM hash changes after P2 mean the secret must be re-stored and the contract redeployed | Freeze in the P2 gate; WS2 must finish its tests in P1; changes after that only through an ADR |
| OutLayer worker outage during judging | Record a full demo video in P3; keep replay data and tx links static in the web UI |
| NEAR AI signer key rotation | Signature check is flag-only; the match still settles; document it |
| Toolchain drift (near-sdk 5.9, rustc 1.85, wasip2) | Pinned in `rust-toolchain.toml` and CI |
| Merge conflicts | Strict directory ownership; interfaces frozen; the integrator merges serially in a fixed order |
| Low external participation | 25 house agents plus the evolver produce enough seasons for evidence alone |
| Judges' README screening | Fresh-clone subagent check in P4 |

**Critical path:** P0 interfaces → WS1 + WS2 → P2 gate (WASM freeze plus deploy) → Season 1 → evidence → README → submit. WS3–WS6 must land by the end of 11 Nov or they block the P2 gate (WS6 keeper, WS3 SDK).

## 9. Decisions
- ✅ Repo: `Jds-23/open-source-dilemma`, public, MIT.
- ✅ Testnet contract: `osd.baldingsucks7993.testnet`.
- ✅ WS10 human league: **skipped for now** (revisit only if P2 finishes early).
- ⏳ Mainnet bounty season: yes or no, and the budget (decide by 13 Nov, 12:00 UTC).
