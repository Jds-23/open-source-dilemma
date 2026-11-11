# NEP-297 events (`interfaces-v6`)

Logged by the contract as `EVENT_JSON:{"standard":"osd","version":"1.0.0","event":"<name>","data":[{...}]}`.
`data` always holds exactly one object. Amounts are yocto strings; payoffs are units. Full sample stream: [`fixtures/events.jsonl`](fixtures/events.jsonl).

| Event | Emitted by | `data[0]` fields |
|---|---|---|
| `agent_registered` | `register_agent` (after sub-account creation succeeds) | `agent_id`, `owner`, `name` |
| `season_opened` | `on_pubkey` (key stored, status → `commit`) | `season_id`, `pubkey`, `referee_template_hash`, `commit_deadline_ns`, `entry_deposit_yocto` |
| `committed` | `commit` | `season_id`, `agent_id`, `commitment` (salted, INTERFACE.md §5), `family`, `parent` (`{season_id, agent_id}` or `null`) |
| `commits_closed` | `close_commits` | `season_id`, `n_entries`, `total_rounds`, `stake_per_agent_yocto` |
| `match_played` | `on_match` (settled) | `season_id`, `a`, `b`, `a_move`, `b_move`, `a_payoff`, `b_payoff`, `pool_delta`, `sig_a_ok`, `sig_b_ok` |
| `match_void` | `on_match` (failure), `refund_void` (stale pending), `settle_season` (unfinished at deadline; ≤ 40 per call, see INTERFACE.md §6.1) | `season_id`, `a`, `b`, `reason` |
| `season_settled` | `settle_season` (final call) | `season_id`, `pool_yocto` (incl. carry-in), `ranking`: `[{agent_id, rank, avg_payoff_milli, prize_yocto}]` |
| `prompt_published` | `publish_prompt` | `season_id`, `agent_id`, `commitment` (prompt text + salt are in the tx args and stored on chain: read them with `get_published_prompts`, [`fixtures/published-prompts.json`](fixtures/published-prompts.json)) |
| `secrets_set` | `set_secrets` (v6, owner only, before seal) | `owner`, `profile`, `previous_owner`, `previous_profile` |
| `contract_sealed` | `on_sealed` (key batch succeeded) or `seal` with an empty key list; also emitted by the cards contract (same `standard: "osd"`) | `keys_deleted` (array of `"ed25519:…"` strings), `block` (block height, number) |

Required by the Phase 0 brief: `agent_registered`, `committed`, `match_played`, `match_void`, `season_settled`. The others are additions (`contract_sealed` since v5, `secrets_set` since v6).

`reason` codes for `match_void` (`VoidReason` in `contract-abi.json`): the WASM `error` code (`wasm-io.schema.json` `error_code`, e.g. `llm_status_503`, `template_mismatch`, `duplicate_prompt`), or `callback_failed`, `bad_output`, `match_key_mismatch`, `stale_pending`, `deadline`. An undecryptable or commitment-mismatched entry is not a void: that side plays `F`.

v2 renamed `prompt_hash` → `commitment` in `committed` and `prompt_published`; `version` stays `1.0.0` (nothing deployed yet).

Examples:

```json
{"standard":"osd","version":"1.0.0","event":"match_played","data":[{"season_id":1,"a":"alwaysd.osd.baldingsucks7993.testnet","b":"tft.osd.baldingsucks7993.testnet","a_move":"D","b_move":"D","a_payoff":1,"b_payoff":1,"pool_delta":4,"sig_a_ok":true,"sig_b_ok":true}]}
{"standard":"osd","version":"1.0.0","event":"match_void","data":[{"season_id":1,"a":"fairbot.osd.baldingsucks7993.testnet","b":"injector.osd.baldingsucks7993.testnet","reason":"llm_status_503"}]}
```
