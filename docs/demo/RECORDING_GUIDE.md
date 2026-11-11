# Recording guide

How to capture the footage for [VIDEO_SCRIPT.md](VIDEO_SCRIPT.md) and the stills in [`screenshots/`](screenshots/).
Everything reads public testnet state; no wallet, no keys and no `.env` are needed for the web shots.

## 0. Setup (once)

```sh
git clone https://github.com/Jds-23/open-source-dilemma && cd open-source-dilemma
pnpm install --frozen-lockfile
pnpm --filter @osd/web exec playwright install chromium   # only for the scripted screenshots
```

Screen: macOS, 1440×900 browser viewport (Chrome window "1440×900" via DevTools device toolbar, or a 1440×900 display).
Record at 2× (Retina) and export 1920×1080. Mobile clips: DevTools device "iPhone 14" (390×844, DPR 2).
Hide bookmarks bar, extensions and notifications (Do Not Disturb). Browser zoom 100 %. Dark theme (toggle top-left pill) for the video; light for one B-roll pass.
Terminal: 120×32, font 16 pt, dark theme, `PS1='$ '`, `clear` before each take.

## 1. Run the web app against testnet

The match → `play_match` tx index is not a contract view; the app reads it from `NEXT_PUBLIC_INDEX_URL`.
Either serve the repo copy locally, or use the raw GitHub file (fetched server-side, so CORS doesn't matter).

```sh
# terminal 1: serve the tx index (or skip and use the raw GitHub URL below)
cd ops/runs && python3 -m http.server 3999 --bind 127.0.0.1

# terminal 2: the web app
cd web
NEXT_PUBLIC_CONTRACT_ID=osd.baldingsucks7993.testnet \
NEXT_PUBLIC_CARDS_CONTRACT_ID=cards.osd.baldingsucks7993.testnet \
NEXT_PUBLIC_NETWORK=testnet \
NEXT_PUBLIC_RPC_URL=https://rpc.testnet.near.org \
NEXT_PUBLIC_INDEX_URL=http://127.0.0.1:3999/tx-index.json \
NEARAI_API_KEY= \
pnpm build && pnpm start          # production build: no Next dev overlay in the shots
```

- Raw index alternative: `NEXT_PUBLIC_INDEX_URL=https://raw.githubusercontent.com/Jds-23/open-source-dilemma/main/ops/runs/tx-index.json`.
  Regenerate after new seasons with `pnpm --filter @osd/ops export-tx-index --out ops/runs/tx-index.json` (ops owner).
- If the public RPC is slow or returns 429, set `NEXT_PUBLIC_RPC_URL` to another testnet RPC (e.g. `https://test.rpc.fastnear.com`).
  The agent page makes the most view calls (~15 s cold); load each page once before recording so the cache is warm.
- **Fixture fallback** (no network): unset `NEXT_PUBLIC_CONTRACT_ID`; the app runs on `interfaces/fixtures` plus synthetic
  demo seasons. Label any such footage "fixtures" on screen; never present it as testnet data.

## 2. Browser shots, in order

Base URL `http://localhost:3000`. Season 1 is the settled reference season; switch to the final hero season once `docs/EVIDENCE.md` lands.

| Shot | URL | Action |
|---|---|---|
| 1 hook | `/` | Wait 2 s on the hero, slow scroll to the stats row (seasons / matches settled / % C / % sigs verified) |
| 2 payoffs | `/how-it-works` | Scroll to the payoff matrix, hover the D/D row |
| 3 sealed | `/match/1/prudentbot/tft-oneshot` | Hold on the lock boxes ("Not published") and the commitment hashes |
| 4 replay | `/match/1/always-c/exploiter` | Grid 1–5 → scroll to both **VERIFIED ON CHAIN** badges → "Verify it yourself" → click the two links below |
| 5a population | `/population` | Hover each season column; hold on the dashed cooperation line |
| 5b leaderboard | `/leaderboard/1` (then the final season) | Hold 2 s on ranks 1–3 and the prize column |
| 5c lineage + cards | `/agent/tft-oneshot` | Lineage tree S1→S4, then the NEP-245 strategy card |
| 8 sandbox (optional) | `/sandbox` | Pick two templates, run (mock referee without `NEARAI_API_KEY`; say so if shown) |

Other good match replays (season 1): `/match/1/fairbot/inj-override` (DD, injector vs program equilibrium),
`/match/1/def-quarantine/prudentbot` (CC).

## 3. Explorer and attestation tabs (shot 4 and 7)

Open in separate tabs beforehand, dark mode where available:

| What | URL |
|---|---|
| play_match tx (always-c vs exploiter) | https://testnet.nearblocks.io/txns/Ax5f9sdDaR2nqL3q3wDKq87FLbd7tVPUYeUnwmMQWToZ |
| its TDX attestation (id 38012) | https://testnet-api.outlayer.ai/attestations/by-tx/Ax5f9sdDaR2nqL3q3wDKq87FLbd7tVPUYeUnwmMQWToZ |
| spot-check match (prudentbot vs tft-oneshot, attestation 38018) | https://testnet.nearblocks.io/txns/27E7Lrmhj6qKDEQXjJZAcra85xixebyQLZFTZZCKtHQZ · https://testnet-api.outlayer.ai/attestations/by-tx/27E7Lrmhj6qKDEQXjJZAcra85xixebyQLZFTZZCKtHQZ |
| contract account (access keys tab, for seal) | https://testnet.nearblocks.io/address/osd.baldingsucks7993.testnet |
| cards contract | https://testnet.nearblocks.io/address/cards.osd.baldingsucks7993.testnet |
| seal tx | `{{SEAL_TX}}` (after `ops/scripts/seal.sh` runs) |
| attack table | https://github.com/Jds-23/open-source-dilemma/blob/main/attacks/RESULTS.md |

In the attestation JSON, highlight (Cmd-F) `ad40dcf455faf4264e72e771c4ab13241b9b264e20ce74e1eeb190bd60c00ec6`: the WASM hash the contract pinned
(`get_season(1).wasm`). Use a JSON viewer extension or Firefox for pretty-printing.

Seal check for shot 7 (anyone can run it; shows `true` and `[]` after seal):

```sh
near view osd.baldingsucks7993.testnet is_sealed '{}' --networkId testnet
near list-keys osd.baldingsucks7993.testnet --networkId testnet
```

## 4. Terminal clips

Recorded by whoever holds the operator keys. Keys are read from `~/.near-credentials/testnet/`; never show that directory
or any `.env` on screen. Speed clips up 4–8× in edit.

**Fast season (keeper), shot 3 / B-roll** (~4 min real time for a small season; see `ops/README.md` "Fast seasons"):

```sh
pnpm --filter @osd/ops house-agents --plan ../agents/plans/season-<n>.json --prestage --params season-params.fast-10.json --execute
pnpm --filter @osd/ops keeper --open season-params.fast-10.json --house-plan ../agents/plans/season-<n>.json --keys 15 --execute
```

Show: `opened season`, `pubkey` landing, the burst of commits (ciphertext only), `close_commits`, 15 parallel `play_match`
lines, `settled`. Without spending: `pnpm --filter @osd/ops keeper --mock` gives the same log shape on the mock contract
(label it "mock").

**Attacks, shot 6** (~2–3 min; outsider account needs ~0.8 testnet NEAR):

```sh
pnpm --filter @osd/attacks run no-season
pnpm --filter @osd/attacks run render     # rewrites the table in attacks/RESULTS.md
```

Show the parallel attack lines ending in `PASS` / `refused`, then the final `N rows: … pass` footer.
Don't run attacks while Phase 3 seasons are in play unless the ops owner agrees (they share accounts and RPC limits).

**MCP CTA, shot 8:** `node packages/sdk/bin/osd.mjs --help`, then show the `osd-mcp` block from `docs/agent-market.md` §3
in the editor (no tokens or key paths on screen).

## 5. Scripted screenshots

The stills in `screenshots/` were taken with Playwright (Chromium) against the dev server above:
desktop 1440×900 at DPR 1, mobile 390×844 at DPR 2, dark + light for home and one match, full page capped at
2400 px (desktop) / 2000 px (mobile) CSS height, JPEG q82, Next dev overlay hidden. Data: live testnet on 2026-11-11
(seasons 1–4 settled, season 5 cancelled). Retake after the final seasons; keep `screenshots/` under 6 MB.
The repo's own UI screenshot suite (fixtures, not testnet) is `pnpm --filter @osd/web screenshots`.
