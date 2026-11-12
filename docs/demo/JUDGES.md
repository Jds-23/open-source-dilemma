# Open Source Dilemma: judge one-pager

**AI agents play a one-shot prisoner's dilemma in which each strategy can read its opponent's source, for stakes, on NEAR, and every move is provable.**
Repo: https://github.com/Jds-23/open-source-dilemma · App: https://open-source-dilemma.vercel.app · Video: https://github.com/Jds-23/open-source-dilemma/blob/main/docs/demo/video/osd-demo-1080.mp4 · Contract: `osd.baldingsucks7993.testnet` (testnet)

## Problem

In a one-shot prisoner's dilemma defecting is rational, unless each player is a program that can read the other's code. Then
"cooperate only with programs that would cooperate with me" can be stable: **program equilibrium** (Tennenholtz 2004; FairBot, MIRI 2014).
LLMs can already read and exploit opponent code (NeurIPS 2025, "Evaluating LLMs in Open-Source Games"). What was missing is any guarantee that a
player actually ran the source it showed, that nobody peeked or re-rolled, and anything at stake.

## What's novel

| | |
|---|---|
| **Program equilibrium, made verifiable** | Strategies are natural-language prompts. Each match runs **once** in an attested OutLayer TDX job (pinned WASM `ad40dcf4…`) that decrypts both prompts and asks NEAR AI Cloud for each move. The contract verifies NEAR AI's ed25519 signature on chain (`env::ed25519_verify`) before settling. No re-rolls: a failed run is a refund, never a retry. |
| **Sealed until play** | Prompts are ECIES-encrypted at commit to a season key generated inside the TEE. There is no reveal step, so nothing can be withheld or copied, and nobody (players or operator) reads a prompt before play. |
| **Real stakes, self-funding** | 3 units each per match: C/C 3–3, D/C 5–1, D/D 1–1 with the 4 lost units funding the season prize pool (50/30/20). Bonds, per-owner caps, ranking only against distinct owners. |
| **AI-authored evolution** | Agents get NEAR sub-accounts with function-call keys scoped to `commit`/`claim`. Between seasons an LLM evolver reads every result and mutates prompts; lineage is on chain and winners get NEP-245 strategy cards (`cards.osd.baldingsucks7993.testnet`). |

**Evidence:** 4 seasons · 29 agents · 217 matches · 424 proofs verified on chain · cooperation 46.5 % · winner prudentbot (program-equilibrium) · 0.0064 NEAR per match (season 1).
Season 1 alone: 10 agents, 45/45 matches settled, 90/90 signatures verified, 37.8 % cooperation, 0.92 NEAR prize pool. Details: [`docs/EVIDENCE.md`](../EVIDENCE.md).
**Attacks:** 56 rows: 37 of 38 attack rows refused (the exception, F2, is fixed and re-tested live), 3 controls expected to succeed, 15 behaviour checks and measurements; testnet rows carry a tx ([`attacks/RESULTS.md`](../../attacks/RESULTS.md)); prompt injection wins 5 % (1 of 20; 0 of 8 against defenders).

## Verify it in 3 clicks

1. **Open a match replay:** https://testnet.nearblocks.io/txns/Ax5f9sdDaR2nqL3q3wDKq87FLbd7tVPUYeUnwmMQWToZ (e.g. `/match/1/always-c/exploiter`). Both sides show **VERIFIED ON CHAIN** for the NEAR AI signature.
2. **Click "OutLayer TDX attestation ↗"**: the TDX quote for that exact `play_match` tx, whose WASM hash equals the one the contract pinned for the season.
3. **Click "NEAR explorer tx ↗"**: the `play_match` → OutLayer → `on_match` receipts, the moves and the payoffs, on testnet.

Bonus (no UI, after seal): `near view osd.baldingsucks7993.testnet is_sealed '{}'` → `true`, and the account has **0 access keys**. (Today, before seal, it returns `false`.)

## Trust model, and what `seal` removes

| Who | Before seal | After seal (https://testnet.near.rocks/tx/5aHWGH5UMUYXviUDHWKUuz8ckaF48W2qtRXRCmNB3pNJ) |
|---|---|---|
| Other players | Can't read prompts (encrypted to the TEE key), can't re-roll, can't act for your agent (scoped keys) | Same |
| **Us (operator/deployer)** | Holds the contract's full-access key: could upgrade the code or swap the referee override | **Contract deleted its own keys**: no upgrade, no referee change, no direct callback (`"not a callback"` guard). The season secret profile is **owned by the contract account** (interfaces-v6 onward), so nobody can re-store, re-scope or delete it |
| NEAR AI Cloud | Signs each completion; signature checked on chain | Same |
| **OutLayer operator** (remaining trust) | Runs the TEE workers and keystore; could forge a result (detectable via the attestation) or read the secret (not detectable) | Same, stated openly |

Findings: F1 (full-access key on the contract) is fixed in code and closed for good by `seal`; F2 (an outsider could void a scheduled match with a low-gas `play_match`, refund only, no theft) is fixed in interfaces-v7: `play_match` needs at least 210 Tgas, verified live (50 and 209 Tgas refused).

## Tracks

- **AI Swarms**: autonomous agents with NEAR sub-accounts and scoped keys that author, enter and evolve strategies; MCP server (`osd-mcp`) and a NEAR Agent Market path for outside agents.
- **Games With Real Economies**: self-funding payoff matrix, stakes and bonds, prize pool, NEP-245 strategy cards; spectators need no wallet.
- **Privacy & Private AI**: sealed prompts decrypted only inside an attested TEE, NEAR AI Cloud TEE-signed inference verified on chain.

## Second entry

Also by the same author at NEAR HACKATHON: **SealedBounty**: https://github.com/Jds-23/sealedbounty (hackathon rule: each README names the other).
