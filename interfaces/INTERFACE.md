# Open Source Dilemma: frozen interfaces (`interfaces-v4`)

Owner: integrator. Changes only through an `interface-change` PR (see `docs/BUILD_PLAN.md` §0).
Machine-readable copies: [`contract-abi.json`](contract-abi.json), [`wasm-io.schema.json`](wasm-io.schema.json), [`events.md`](events.md). Mock data: [`fixtures/`](fixtures/).

The spike (`contracts/dilemma`, `wasm/referee` at the "spike baseline" commit) does **not** implement this yet. WS1 and WS2 bring it to this spec; §9 lists every delta (§9.1: v1 → v2, §9.2: v2 → v3, §9.3: v3 → v4).

---

## 1. Conventions

| Item | Rule |
|---|---|
| Encoding | JSON args and returns (near-sdk default serializer) |
| Amounts | yoctoNEAR as decimal strings (`U128`) |
| Times | `*_ns`: block timestamp in ns as decimal string (`U64`); `*_block`: block height as JSON number |
| Hashes | lowercase hex, sha256 = 64 chars |
| `season_id` | `u32`, assigned by the contract, starts at 1 |
| Moves | `"C"` cooperate, `"D"` defect, `"F"` forfeit (entry invalid: ciphertext undecryptable, malformed plaintext, or `commitment` mismatch; §5) |
| Payoff units | integers; 1 unit = `params.unit_yocto`. Each side stakes 3 units per match |
| Accounts | Agent = sub-account `<name>.<contract>`; `name` matches `^[a-z0-9_-]{2,16}$` |
| Match key | `(season_id, a, b)` with `a < b` (byte order of account ids). String form: `"<season_id>:<a>:<b>"` |

## 2. Payoff matrix (units per side; each side staked 3)

| a / b | a gets | b gets | pool |
|---|---|---|---|
| C / C | 3 | 3 | 0 |
| D / C | 5 | 1 | 0 |
| C / D | 1 | 5 | 0 |
| D / D | 1 | 1 | **4** |
| F / C or F / D | 0 | 3 | 3 |
| C or D / F | 3 | 0 | 3 |
| F / F | 0 | 0 | 6 |

Every row sums to 6 = both stakes, so a season is self-funding. A void match refunds 3 to each side (`refund_void`). A forfeiting entry also loses its bond to the pool at `settle_season`.

## 3. Lifecycle

```
open_season ──OutLayer derive_pubkey──► on_pubkey ─► status "commit"
   (status "pending_key"; on failure "key_failed")
commit … (until commit_deadline_ns)
close_commits ─► status "play" (N entries frozen, stake fixed, excess deposit credited)
schedule_round × total_rounds ─► matches "scheduled"
play_match(a,b) ─OutLayer play_match─► on_match ─► "settled" | "void"
refund_void(a,b) on "void" (or stale "pending") ─► "refunded"
settle_season ─► status "settled" (ranking, pool paid, bonds returned, unpaid pool carried over)
   (after the play deadline: [] per call while unfinished matches are voided in batches of 40)
claim ─► claimable moves into the agent budget
```

Statuses. Season: `pending_key | key_failed | commit | play | settled | cancelled` (`cancelled` = fewer than 2 entries at close; all deposits credited back). Match: `scheduled | pending | settled | void | refunded`.

**One-shot rule (never retry).** `play_match` is accepted only for a `scheduled` match and moves it to `pending` before the OutLayer call. Any callback failure, timeout, malformed output or `match_key` mismatch makes it `void`. There is no path from `pending`/`void` back to `scheduled`.

## 4. Agents and keys

`register_agent` (payable, caller = owner) creates `<name>.<contract>`, transfers `AGENT_ACCOUNT_FUNDING = 0.2 NEAR` to it for storage and gas, and adds **one function-call access key** (`agent_public_key`) with:
- `receiver_id` = the contract
- `method_names` = `["commit", "claim"]`
- `allowance` = 0.25 NEAR

No full-access key is added: the agent account can only call `commit`/`claim` on the contract. Function-call keys cannot attach deposits, so stakes come from the agent's **budget** held in the contract: `attached_deposit - 0.2 NEAR` at registration, plus `fund_agent`. The owner withdraws with `withdraw`. Minimum registration deposit: 0.25 NEAR.

## 5. Encryption (season key)

- Secret profile (OutLayer keystore) holds `PROTECTED_SEASON_SEED` (32 bytes hex, generated in the TEE) and `NEARAI_API_KEY`. Bound to `SecretAccessor::WasmHash` + `Predecessor{Whitelist[<contract>]}`.
- Season secret key: `HKDF-SHA256(salt = none, ikm = seed, info = "osd:ecies:<season_id>", L = 32)`; public key = secp256k1 compressed (33 bytes, 66 hex chars).
- **Salt:** the client draws `salt` = 32 random bytes (CSPRNG) per entry and keeps it (needed for `publish_prompt`).
- **Plaintext** (binary, no JSON): `plaintext = 0x01 || salt (32 bytes) || utf8(prompt)`. Byte 0 is the format version (`0x01`); bytes 1..33 are the salt; the rest, to the end, is the prompt (no terminator, no length prefix).
- **Ciphertext:** `ciphertext_hex = hex(eciesjs.encrypt(pubkey_hex, plaintext))` with `eciesjs` 0.4.16 defaults.
- **Commitment** (the `commitment` arg of `commit`): `commitment = sha256_hex(utf8(prompt) || salt (32 bytes) || utf8(agent_id))`, where `agent_id` is the committing agent's account id (`<name>.<contract>`, the `a`/`b` of its matches). No separators: the verifier knows `agent_id`, and the salt is fixed-length, so the split is unambiguous.
- Reference code: `packages/sdk` `sealPrompt(pubkey, prompt, agent_id)` → `{ciphertext_hex, commitment, salt}`; `encodePlaintext`, `decodePlaintext`, `commitment`.
- Limits: prompt ≤ 4000 bytes; plaintext ≤ 4033 bytes; `ciphertext_hex` ≤ 8400 chars (4033 + 97 B ECIES overhead = 8260 hex).
- Test vector: [`fixtures/test-key-vector.json`](fixtures/test-key-vector.json) (**TEST-ONLY**, derived from a public string; cross-checked against the spike WASM's `derive_pubkey`).
- **Why salted:** an unsalted `sha256(prompt)` lets anyone recognise a well-known prompt (e.g. plain Always-D) during the commit window. The salted commitment reveals nothing until the owner publishes.
- **Duplicate prompts** are therefore refused in the TEE, not on chain: per match, after decrypting and verifying both sides (§8), if `prompt_a == prompt_b` byte-exact (same or different owners) the WASM returns error `duplicate_prompt`; the contract voids the match and `refund_void` refunds 3 units to each side. Duplicates in *different* matches are not detected during the season; they become visible post-season via optional `publish_prompt`. Accepted for the hackathon.

## 6. Contract methods

`init`: `new({wasm_url, wasm_hash, secrets_owner, secrets_profile, nearai_signer, outlayer_account})`. `nearai_signer` = 32-byte ed25519 pubkey hex. Caller becomes `owner`.

### 6.1 Calls

| Method | Caller | Deposit | Args | Returns | Refuses when |
|---|---|---|---|---|---|
| `register_agent` | owner of the new agent (any account) | ≥ 0.25 NEAR | `{name, agent_public_key}` (`"ed25519:<base58>"`) | `AgentId` (promise result) | name taken/invalid |
| `fund_agent` | anyone | > 0 | `{agent_id}` | `U128` new budget | unknown agent |
| `withdraw` | agent's owner | 1 yocto | `{agent_id, amount_yocto}` | `U128` new budget | not owner; amount > budget |
| `open_season` | contract owner | ≥ 0.02 NEAR (OutLayer) | `{params: SeasonParams, wasm_url?, wasm_hash?, secrets_profile?}` (overrides default to `get_config`; `wasm_url` and `wasm_hash` only together; frozen in the season and used by its `play_match`) | `u32` season_id (returned directly; the detached OutLayer call ends in `on_pubkey`, which sets the key) | previous season not `settled`/`cancelled`/`key_failed`; bad params; only one of `wasm_url`/`wasm_hash` |
| `on_pubkey` | **private** callback | – | `{season_id}` + callback result `{pubkey}` | `Option<String>` | – |
| `commit` | agent account or its owner | 0 | `{season_id, agent_id, ciphertext_hex, commitment, family, parent}` | `null` | status ≠ `commit`; past deadline; agent already entered (no overwrite); owner reached `max_entries_per_owner`; `max_agents` reached; budget < `entry_deposit_yocto`; bad hex/size; `family` not `^[a-z0-9_]{1,32}$` |
| `close_commits` | anyone | 0 | `{season_id}` | `u32` n_entries | before deadline; status ≠ `commit` |
| `schedule_round` | anyone | 0 | `{season_id}` | `MatchKey[]` for the new round | status ≠ `play`; all rounds scheduled |
| `play_match` | anyone (keeper) | ≥ 0.02 NEAR (OutLayer; unused part refunded by OutLayer to caller) | `{season_id, a, b}` | promise → `String` `"settled CD"` / `"void"` | match not `scheduled` |
| `on_match` | **private** callback | – | `{season_id, a, b}` + callback result (WASM output) | `String` | match not `pending` |
| `refund_void` | anyone | 0 | `{season_id, a, b}` | `U128` refunded per side | match not `void`, and not `pending` for > 250 blocks |
| `settle_season` | anyone | 0 | `{season_id}` | `LeaderboardRow[]`; returns `[]` while unfinished matches are voided in batches of 40 after the play deadline: call again until it returns the ranking | status ≠ `play`; unfinished matches and `now < play_deadline_ns` (after the deadline, unfinished matches are voided and refunded, ≤ 40 per call because of the 100-log receipt limit) |
| `claim` | agent account or its owner | 0 | `{season_id, agent_id}` | `U128` moved to budget | nothing claimable |
| `publish_prompt` | agent's owner | 0 | `{season_id, agent_id, prompt, salt}` (`salt` 64 hex) | `null` (stores `prompt` + `salt`, see `get_published_prompts`) | season not `settled`; `sha256(utf8(prompt) ‖ salt ‖ utf8(agent_id)) ≠ commitment` |

`commit` debits `entry_deposit_yocto = bond + 3 × unit × (max_agents − 1)` from the budget. `close_commits` fixes `stake_per_agent_yocto = 3 × unit × (N − 1)` and credits the excess to `claimable`. `on_match` credits payoffs to `claimable` and the pool delta to the season pool. `settle_season` ranks, splits the pool by `prize_split_bps`, and credits prizes and non-forfeited bonds to `claimable`.

**Claimable formula** (per agent per season, after `settle_season`; confirmed by WS-1, implemented in the contract):
`claimable = unused stake + match payoffs + 3 units per void match + prize share + bond`, where unused stake = `entry_deposit_yocto − bond − stake_per_agent_yocto`, payoffs/void refunds are in units × `unit_yocto`, and the bond is withheld (→ pool) if the agent forfeited (`F`) any match. Summed over all agents it equals the total entry deposits. Example per agent with breakdown: [`fixtures/claimable.json`](fixtures/claimable.json). Void matches are credited when `refund_void` runs (it also works after settlement); matches cut off at the deadline are refunded by `settle_season` itself. If some rounds were never scheduled by the deadline, the agent also gets `3 × unit × (N − 1 − its scheduled matches)` back.

**Carry-over.** Prizes are `floor(pool × bps / 10000)`. Whatever is left (rounding dust, plus the shares of split slots with no ranked agent) is the season's `carry_over_yocto`. It is added to the **next** season's pool at `open_season` (`Season.carry_in_yocto`; pending amount in `get_config().carry_over_yocto`). A season that never plays (`key_failed`, `cancelled`) hands its carry-in back to the next one.

**Other rules.** `get_published_prompts` lists in first-publish order; publishing again (same hash-checked prompt) is accepted and keeps the first position. `commit` refuses `parent.season_id < 1`. `play_match` is still accepted after `play_deadline_ns` while the season is `play`; `settle_season` voids whatever is unfinished. The contract has no setter for the config wasm/secrets; use the `open_season` overrides.

**Storage** (paid by the contract account, so fund it): about 4.3 KB per entry (ciphertext stored as bytes, max 4200 B, plus metadata) and about 0.7 KB per match. A 40-agent season (40 entries, 780 matches) needs ≈ 0.72 MB ≈ 7.2 NEAR at 1 NEAR / 100 KB; a 6-agent season < 0.4 NEAR.

`commit` does **not** check for duplicate prompts (commitments are salted, so they never collide); see §5.

`parent` = `{season_id, agent_id} | null` (lineage). `prompt` is published only voluntarily after settlement (OutLayer mode has no reveal step; the WASM never outputs prompt text).

### 6.2 Views

| View | Args | Returns |
|---|---|---|
| `get_config` | `{}` | `{owner, outlayer_account, wasm_url, wasm_hash, secrets_owner, secrets_profile, nearai_signer, current_season_id, carry_over_yocto}` ([fixture](fixtures/config.json)) |
| `get_season` | `{season_id}` | `Season \| null` |
| `get_season_pubkey` | `{season_id}` | `String \| null` (66 hex) |
| `get_entries` | `{season_id, from_index?, limit?}` | `Entry[]` (commit order) |
| `get_matches` | `{season_id, from_index?, limit?, status?}` | `Match[]` (schedule order) |
| `get_leaderboard` | `{season_id}` | `LeaderboardRow[]` (live while playing; final after settle) |
| `get_agent` | `{agent_id}` | `Agent \| null` |
| `get_lineage` | `{agent_id}` | `LineageEntry[]` (one per season entered; follow `parent` to walk ancestors) |
| `get_claimable` | `{season_id, agent_id}` | `U128` (formula §6.1; [fixture](fixtures/claimable.json)) |
| `get_published_prompts` | `{season_id, from_index?, limit?}` | `PublishedPrompt[]` = `[{agent_id, prompt, salt, commitment}]` (first-publish order; only prompts revealed via `publish_prompt`; [fixture](fixtures/published-prompts.json)) |

Pagination defaults: `from_index = 0`, `limit = 100`, max 200.

### 6.3 Types (see `contract-abi.json` `$defs`; examples in `fixtures/`)

- `SeasonParams` `{commit_deadline_ns, play_deadline_ns, unit_yocto, bond_yocto, max_agents (≤ 40), max_entries_per_owner, referee_template_hash, model, prize_split_bps: u16[] (sum 10000)}`; immutable once opened.
- `Season` `{season_id, status, params, wasm{url,hash}, secrets_profile, pubkey, entry_deposit_yocto, stake_per_agent_yocto, n_entries, total_rounds, rounds_scheduled, n_matches, n_settled, n_void, pool_yocto, carry_in_yocto, carry_over_yocto, opened_at_ns, closed_at_ns, settled_at_ns}` ([fixture](fixtures/season.json)); `wasm` + `secrets_profile` are the season's pinned referee; `pool_yocto` includes `carry_in_yocto`.
- `Agent` `{agent_id, name, owner, registered_at_ns, budget_yocto, seasons}` ([fixture](fixtures/agents.json))
- `Entry` `{season_id, agent_id, owner, family, parent, commitment, ciphertext_hex, committed_at_ns}` ([fixture](fixtures/entries.json))
- `MatchKey` `{season_id, a, b}`
- `Match` `{season_id, a, b, round, match_key, status, a_move, b_move, a_payoff, b_payoff, pool_delta, sig_a_ok, sig_b_ok, a_chat_id, b_chat_id, a_signed_text, b_signed_text, a_sig, b_sig, void_reason, requested_at_block, settled_at_block}` ([fixture](fixtures/matches.json))
- `LeaderboardRow` `{agent_id, owner, family, matches_counted, total_payoff_counted, avg_payoff_milli, rank, prize_yocto}` ([fixture](fixtures/leaderboard.json))
- `LineageEntry` `{season_id, agent_id, commitment, family, parent, rank, avg_payoff_milli}` ([fixture](fixtures/lineage.json))
- `PublishedPrompt` `{agent_id, prompt, salt, commitment}` ([fixture](fixtures/published-prompts.json))

## 7. Scheduling and ranking

- **Schedule:** circle-method round robin over entries in commit order. N even → N−1 rounds of N/2; N odd → N rounds with one bye. Each pair is stored as `(season_id, min(a,b), max(a,b))`; the contract alone creates match keys, so a pair can never be replayed under a new id. 6 agents → 15 matches; 30 → 435.
- **Ranking** (`settle_season`, `get_leaderboard`): for each agent, `counted` = its `settled` matches whose opponent has a **different owner**. `avg_payoff_milli = floor(1000 × Σpayoff / |counted|)`. Sort by `avg_payoff_milli` desc, then `total_payoff_counted` desc, then commit order. Agents with `matches_counted = 0` get `rank = null` and no prize. Self-owned matches still pay out; they just don't count toward rank.
- **Signature check (flag only):** `sig_*_ok = ed25519_verify(sig, signed_text, nearai_signer)`. A false flag never blocks settlement.

## 8. Referee WASM I/O (`wasm-io.schema.json`)

Input (`input_data`, JSON string), one of:
- `{"action":"derive_pubkey","season":<u32>}` → output `{"pubkey":"<66 hex>"}`
- `{"action":"play_match","season":<u32>,"match_key":"<s>:<a>:<b>","a","b","ct_a","ct_b","hash_a","hash_b","referee_template_hash","params":{model,temperature,seed,max_tokens,enable_thinking,max_prompt_bytes}}`; `hash_a`/`hash_b` = the entries' salted `commitment` (§5)

Play output, **≤ 900 bytes, never any prompt text**:
`{match_key, a_move, b_move, a_chat_id, b_chat_id, a_signed_text, b_signed_text, a_sig, b_sig}`
or error `{match_key, error}` (contract voids the match; `error` ∈ `error_code` in the schema: `bad_input`, `unknown_action`, `predecessor_not_allowed`, `template_mismatch`, `no_seed`, `bad_seed`, `key_derivation`, `no_api_key`, `duplicate_prompt`, `llm_send`, `llm_timeout`, `llm_json`, `llm_status_<3 digits>`).

WASM rules: refuse unless `NEAR_PREDECESSOR_ID` = the contract; error if `referee_template_hash` ≠ the compiled-in template hash; per side: decrypt `ct_*`, parse the §5 plaintext (`0x01 || salt || prompt`), recompute `sha256(prompt ‖ salt ‖ utf8(a or b))`; the side gets `F` if decryption fails, the plaintext is shorter than 33 bytes, byte 0 ≠ `0x01`, the prompt is not valid UTF-8 or exceeds `max_prompt_bytes`, or the commitment ≠ `hash_*` (no LLM calls if any side is `F`; the valid side's move is recorded as `C`, payoff unaffected; chat/sig fields `""`); if both sides are valid and `prompt_a == prompt_b` byte-exact → error `duplicate_prompt` (checked before any LLM call); LLM reply parsed strictly (first character of the trimmed, uppercased reply must be `C`/`D`, else `D` + `nonstrict` log flag); signed text format `<model>:<sha256(request_body)>:<sha256(response_body)>`. Fixtures: [`wasm-inputs.json`](fixtures/wasm-inputs.json), [`wasm-outputs.json`](fixtures/wasm-outputs.json), [`wasm-duplicate-example.json`](fixtures/wasm-duplicate-example.json) (max 820 B; signed with the TEST-ONLY key in [`test-nearai-signer.json`](fixtures/test-nearai-signer.json)).

## 9. Deltas from the spike baseline

| Area | Spike | `interfaces-v1` (v2 changes in §9.1) |
|---|---|---|
| Match id | caller-supplied `match_id: u64` (replayable under new ids) | contract-scheduled `(season_id, a, b)`, `a < b` |
| Seasons | one season string in `new`, `init_season()` | `open_season(params)` → `u32` ids, stake/bond/deadlines, statuses |
| Payoff D/C | 5 / **0** | 5 / **1** (spec §1; every outcome sums to 6), D/D sends 4 to the pool, `F` added |
| Commit | `commit(ciphertext_hex)`, overwritable, no stake | `commit({season_id, agent_id, ciphertext_hex, prompt_hash, family, parent})`, one per agent, stake + bond from budget, duplicate hash refused, per-owner cap |
| Agents | plain accounts | `register_agent` sub-accounts + FC key scoped to `commit`/`claim`; `fund_agent`, `withdraw` |
| Money | none | `claimable` ledger, `claim`, `refund_void`, `settle_season` pool split |
| Ranking | none | avg payoff vs distinct owners |
| WASM input | `{action, season:"s1", match_id, a:{id,ct}, b:{id,ct}}` | flat `{action, season:u32, match_key, a, b, ct_a, ct_b, hash_a, hash_b, referee_template_hash, params}` |
| HKDF info | `osd:ecies:s1` | `osd:ecies:<season_id>` (e.g. `osd:ecies:1`) |
| WASM output | short keys `{m,a,b,ia,ib,ta,sa,tb,sb,k}` | long keys above; `k` (signer address) dropped (contract pins the key); `error` variant; `F` move |
| Predecessor | hard-coded `dilemma-spike.baldingsucks7993.testnet` | the deployed contract (`osd.baldingsucks7993.testnet` on testnet), compile-time constant |
| Referee template | inline, D/C = 5/0, no template hash | canonical delimited template (WS2), hash pinned in `SeasonParams.referee_template_hash` and checked by the WASM |
| Events | none (logs only) | NEP-297 `osd` events ([`events.md`](events.md)) |
| Views | `get_pubkey`, `get_commit`, `get_match`, `get_config` | §6.2 |
| Prompts after season | never public | optional `publish_prompt` (hash-checked) |

### 9.1 `interfaces-v1` → `interfaces-v2` (salted commitment)

| Area | `interfaces-v1` | `interfaces-v2` |
|---|---|---|
| Commit hash | `prompt_hash = sha256(prompt)` (unsalted, recognisable) | `commitment = sha256(utf8(prompt) ‖ salt[32] ‖ utf8(agent_id))` |
| ECIES plaintext | raw UTF-8 prompt | `0x01 ‖ salt[32] ‖ utf8(prompt)` |
| `commit` args | `prompt_hash` | `commitment` |
| `Entry`, `LineageEntry`, events `committed`/`prompt_published` | `prompt_hash` | `commitment` |
| Duplicate prompts | refused by `commit` (same `prompt_hash` in season) | no on-chain check; WASM returns `duplicate_prompt` for byte-equal prompts in one match → `void` → `refund_void`; cross-match duplicates only visible post-season via `publish_prompt` |
| `publish_prompt` | `{season_id, agent_id, prompt}`, checks `sha256(prompt)` | `{season_id, agent_id, prompt, salt}`, checks the commitment |
| `F` move | undecryptable or `sha256(plaintext) ≠ hash_*` | undecryptable, malformed plaintext, oversize prompt, or commitment ≠ `hash_*` |
| WASM `error` | free string ≤ 64 chars | `error_code` enum (+ `llm_status_NNN`); `Match.void_reason` = `VoidReason` |
| Referee placeholder text | D vs C = 5/0 | CC 3/3, DC 5/1, CD 1/5, DD 1/1 (+4 pool); `referee_template_hash` changed (still a placeholder, WS2 owns the final template) |
| Fixtures | – | per-agent TEST-ONLY salts in `prompts.json`; `test-key-vector.json` sample has `salt_hex`, `plaintext_hex`, `commitment`; new `wasm-duplicate-example.json` |

### 9.2 `interfaces-v2` → `interfaces-v3` (WS2 referee accepted)

Canonical referee template = [`wasm/referee/referee-template.txt`](../wasm/referee/referee-template.txt) (compiled in byte-exact); `referee_template_hash` = `556bce7073d6cd3d62a798e36b36b1eda1c61c3b448be58fc928b0e2b614f865`. `fixtures/referee-template.txt` is a byte-identical copy written by `pnpm fixtures`; all fixtures carry this hash. WS2 decisions accepted by the integrator:

| # | Area | Decision |
|---|---|---|
| i | Forfeit | If one side is `F`, no LLM call is made; the valid side's move is recorded as `C` (its payoff is unaffected: `F` scoring is fixed by §2). |
| ii | Parser | Strict: the first character of the trimmed (uppercased) reply must be `C` or `D`; anything else → `D` and a `nonstrict` flag in the log. A reply longer than one letter (other than `C.`/`D.`) is also flagged. |
| iii | Model | Model comes from on-chain `params.model` only; `NEARAI_MODEL` env is ignored. |
| iv | Base URL | Production build accepts `NEARAI_BASE_URL` only if it is `https://*.near.ai` (else the compiled-in default). Cargo feature `insecure-base-url` lifts this for local mock runs only; it changes the WASM hash and is never deployed. |
| v | Sanitising | `<` / `>` inside both strategies are replaced with fullwidth `＜` / `＞` before templating, so only referee-written section tags exist. |
| vi | Output size | If the play output exceeds 900 bytes, proof fields are dropped in order: `b_signed_text`+`b_sig`, then `a_signed_text`+`a_sig`, then `b_chat_id`, then `a_chat_id` (contract treats them as flag-only). |

Integrator additions in v3:

| Area | `interfaces-v2` | `interfaces-v3` |
|---|---|---|
| Published prompts | `publish_prompt` only emits `prompt_published` (text only in tx args) | contract stores `{prompt, salt}`; new view `get_published_prompts({season_id, from_index?, limit?}) → PublishedPrompt[]`; fixture `published-prompts.json` |
| Claimable | undocumented sum | formula in §6.1 (WS-1 to confirm); fixture `claimable.json` with breakdown |
| Config | no fixture | fixture `config.json` (`get_config` shape) |
| Lineage fixture | `grim.parent.season_id = 0` | `1` (season ids start at 1); `Parent.season_id` minimum 1 |

### 9.3 `interfaces-v3` → `interfaces-v4` (WS1 contract decisions)

| Area | `interfaces-v3` | `interfaces-v4` |
|---|---|---|
| `settle_season` | one call returns the ranking | after the play deadline, unfinished matches are voided ≤ 40 per call (100-log receipt limit); returns `[]` until the final call returns the ranking |
| Prize remainder | unspecified | `carry_over`: dust + unfilled slots roll into the next season's pool; `Season.carry_in_yocto`, `Season.carry_over_yocto`, `Config.carry_over_yocto` |
| Referee per season | config `wasm_url`/`wasm_hash`/`secrets_profile` for every season | optional `open_season` overrides `wasm_url`+`wasm_hash` (together), `secrets_profile`; pinned per season, `Season.secrets_profile` added |
| `open_season` after `key_failed` | refused (previous not `settled`/`cancelled`) | allowed |
| `open_season` return | promise | `u32` returned directly (OutLayer call detached) |
| Referee output | all proof fields required | missing `*_chat_id`/`*_signed_text`/`*_sig` read as `""` (WS-2 §9.2 vi); sig flags false |
| Misc | – | `get_published_prompts` first-publish order, re-publish keeps position; `parent.season_id ≥ 1`; `play_match` allowed after the play deadline; storage sizes documented (§6.1) |

Additions beyond the Phase 0 brief (so other workstreams don't block): `fund_agent`, `withdraw`, `publish_prompt`, `get_config`, `get_entries`, `get_claimable`, `get_published_prompts`, events `season_opened`, `commits_closed`, `prompt_published`, move `F`, WASM inputs `hash_a`/`hash_b`/`action`.

## 10. Fixture notes

- `fixtures/generate.mjs` (`pnpm fixtures`) regenerates everything from fixed TEST-ONLY seeds and salts (`sha256("osd TEST-ONLY salt v1:<name>")`; real clients use random salts); only ECIES ciphertext bytes change between runs.
- `fixtures/referee-template.txt` is a byte-identical copy of the canonical WS2 template `wasm/referee/referee-template.txt` (sha256 `556bce70…f865`, §9.2); the generator reads the WASM copy, so editing the template means re-running `pnpm fixtures` (and it changes the hash).
- Season 1 fixture: 6 agents / 5 owners (`tft` and `grim` share `alice.testnet`, so that match is excluded from ranking), 15 matches, 1 void (`fairbot` vs `injector`), pool 20 units.
- `grim.parent` = `{season_id: 1, agent_id: tft…}` (a same-season parent, a fixture simplification so the lineage link resolves within the fixtures). `config.json` wasm url/hash are placeholders until the P2 freeze; `secrets_profile` `osd` is illustrative. `claimable.json` adds a `breakdown` and `forfeited` flag for readability; the view returns only the `U128` total.
