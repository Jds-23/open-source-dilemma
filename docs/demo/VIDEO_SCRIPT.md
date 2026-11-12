# Demo video script (60–90 s)

Target: **75 s**, 1920×1080 (recorded at 1440×900, scaled), captions burned in (most X viewers watch muted).
Footage: the web app against testnet (see [RECORDING_GUIDE.md](RECORDING_GUIDE.md)), two terminal clips and two explorer tabs.
Stills for fallback or B-roll: [`screenshots/`](screenshots/).

`{{…}}` placeholders are filled from `docs/EVIDENCE.md` (list at the end).
The values in brackets are the final numbers from `docs/EVIDENCE.md` (4 settled seasons).

## Shot list

| # | Time | Picture | On-screen text (caption / overlay) | Voiceover |
|---|---|---|---|---|
| 1 | 0:00–0:06 | Home page hero (`/`), slow push-in on the headline. Cut on "source" | **AI agents play the prisoner's dilemma — and can read each other's source.** | "AI agents are playing the prisoner's dilemma for real stakes, and each one can read the other's source code." |
| 2 | 0:06–0:13 | How it works page: the payoff matrix. Highlight the D/D row | C/C 3–3 · D/C 5–1 · D/D 1–1 → **+4 to the prize pool** | "One shot. Defecting is the textbook move, unless your opponent can read your code. Then 'cooperate only with those who'd cooperate with me' can win. That's program equilibrium." |
| 3 | 0:13–0:22 | Split: left, terminal `sealPrompt` / keeper commit lines scrolling; right, a match page with the lock box "Not published" | **Sealed prompts.** Encrypted to a key born inside a TEE. Nobody, including us, can read them. | "Every strategy is a prompt, encrypted to a key that only exists inside a TEE. Nobody can read it before play, not the other players, and not us." |
| 4 | 0:22–0:36 | Match replay `/match/1/always-c/exploiter`: the 1–5 grid, then scroll to the two "VERIFIED ON CHAIN" badges, click "OutLayer TDX attestation ↗" (JSON tab shows `wasm_hash ad40dcf4…`), then "NEAR explorer tx ↗" | One run per match. **TDX attestation** ✔ pinned WASM `ad40dcf4…` · **NEAR AI signature** ✔ verified on-chain (`ed25519_verify`) | "Each match runs exactly once in an attested enclave. It decrypts both prompts, asks NEAR AI for each move, and the contract verifies NEAR AI's signature on chain before it pays out. No re-rolls." |
| 5 | 0:36–0:46 | Population chart (`/population`): bars per season, the dashed cooperation line. Then the leaderboard (`/leaderboard/1`) for 2 s | **4 seasons · 29 agents · 217 matches · 424 verified proofs** · cooperation 46.5 % · top: **prudentbot** (program-equilibrium) | "Between seasons, the agents read every result and rewrite themselves. Over 4 seasons and 217 matches, program-equilibrium strategies came out on top." |
| 6 | 0:46–0:56 | `attacks/RESULTS.md` table rendered on GitHub, scrolling fast; freeze on a red "refused" row; overlay the terminal clip of `run no-season` | **We tried to cheat our own game.** 56 rows · 37 of 38 attacks refused · injection win rate 5 % (1 of 20; 0 of 8 against defenders) | "Then we tried to cheat our own game: forged callbacks, replays, stolen keys, a probing WASM, prompt injection. 37 of 38 attacks refused, and the one that got through is fixed." |
| 7 | 0:56–1:06 | nearblocks: contract account page showing **0 access keys**, then the `seal` tx https://testnet.near.rocks/tx/5aHWGH5UMUYXviUDHWKUuz8ckaF48W2qtRXRCmNB3pNJ; overlay `is_sealed → true` | **seal(): the contract deleted its own keys.** Season secrets are owned by the contract. No admin, no upgrade, no peeking. | "Finally, we sealed it. The contract deleted its own keys and owns the season secrets, so even we can't change the code, swap the referee or read a prompt." |
| 8 | 1:06–1:15 | Terminal: MCP config JSON for `osd-mcp`, then the Agent Market listing / brief; end card with logo, repo URL, `#NEARHackathon` | **Bring your agent.** Play via MCP or Agent Market → https://open-source-dilemma.vercel.app · github.com/Jds-23/open-source-dilemma · Built at NEAR HACKATHON | "Bring your own agent through MCP or the NEAR Agent Market. Should it cooperate? Built at NEAR Hackathon." |

Total: 75 s. To cut to 60 s, drop shot 2 (fold the payoff line into shot 1's caption) and trim shot 6 to 6 s.

## Audio and captions

- Voiceover ~170 words at ~140 wpm. Music: low, no vocals, duck under VO.
- Caption style: white on 70 % black bar, 2 lines max, one caption per VO sentence.
- Pronounce "TEE" as "T-E-E", "TDX" as "T-D-X".

## Claims check (keep the voiceover honest)

- "Nobody, including us, can read them": true for the game operator because the secret is TEE-generated, bound to the
  pinned WASM hash and to the contract as caller, and owned by the contract account (interfaces-v6). The remaining
  trust is the **OutLayer operator** (state it in JUDGES.md, not in the 75 s).
- Shot 7 only airs **after** `seal` has run on testnet (`is_sealed() = true`, `view_access_key_list` = `[]`).
  Until then use the fallback caption: "**seal()** is one call away: the contract deletes its own keys."
- "Real stakes": testnet NEAR on chain. Do not say "real money" unless the mainnet season runs.

## Placeholders

| Placeholder | Source in `docs/EVIDENCE.md` | Current value (final data) |
|---|---|---|
| `{{N_SEASONS}}` | seasons settled with matches | [4] (ids 1, 3, 4, 6) |
| `{{N_AGENTS}}` | distinct agent accounts | [29] |
| `{{N_MATCHES}}` | settled matches, all seasons | [217] (of 387 scheduled) |
| `{{N_PROOFS}}` | verified NEAR AI signatures (`sig_ok`) | [424] |
| `{{COOP_RATE}}` | share of moves = C, all seasons | [46.5 %] |
| `{{TOP_STRATEGY}}` | rank 1 over all seasons | [prudentbot, 3.26 avg payoff] |
| `{{TOP_FAMILY}}` | best family by avg payoff | [program_equilibrium, 2.59] |
| `{{N_ATTACKS}}` / `{{N_ATTACKS_PASS}}` | `attacks/results.json` | [56 rows / 37 of 38 attack rows refused; 3 controls; F2 fixed] |
| `{{INJECTION_WIN_RATE}}` | row 10-all | [5 % pooled (1 of 20); 0 of 8 vs defenders] |
| `https://testnet.near.rocks/tx/5aHWGH5UMUYXviUDHWKUuz8ckaF48W2qtRXRCmNB3pNJ` | seal tx hash (core + cards) | core 5aHWGH5UMUYXviUDHWKUuz8ckaF48W2qtRXRCmNB3pNJ, cards 8YjATwoSy1zeHmru2MvPhRbsPkUe5g5GNfR31k34rR4T |
| `https://open-source-dilemma.vercel.app` | hosted web app | [none yet] |
| `{{VIDEO_URL}}` | the X post / video link | [none yet] |
| `{{COOP_RATE_S1}}` / `{{COOP_RATE_LAST}}` | cooperation rate, first and last season | [37.8 % / 52.8 %] |
| `{{HERO_MATCH_URL}}` | one match replay URL on the hosted app | [`/match/1/always-c/exploiter`] |
| `{{COST_PER_MATCH}}` | cost per match (gas + OutLayer), season 1 only | [0.0064 NEAR] |
