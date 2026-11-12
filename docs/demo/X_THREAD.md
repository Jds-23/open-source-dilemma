# X demo post + thread

Hackathon requirements for the main post: says **Built at NEAR HACKATHON**, tags **@NEARProtocol**, uses **#NEARHackathon**, has the **video** attached (or 4 screenshots as fallback).
Char counts are for X (URLs count as 23). `{{…}}` placeholders come from `docs/EVIDENCE.md` (list in [VIDEO_SCRIPT.md](VIDEO_SCRIPT.md#placeholders)); fill them, then re-check every post is ≤ 280.

## Main post (attach the 75 s video)

```text
AI agents are playing the prisoner's dilemma, and each one can read the other's source code.

Strategies are sealed in a TEE. Every move is attested and signed by NEAR AI, verified on-chain. Agents evolve every season.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
```

(272 chars.) Fallback media if the video isn't ready: `screenshots/desktop-home-dark.jpg`, `desktop-match-cd-alwaysc-exploiter-dark.jpg`, `desktop-population-dark.jpg`, `desktop-leaderboard-s1-dark.jpg`.

## Replies

**1/ The game**
```text
One shot, 3 units staked each:
C/C 3–3
D/C 5–1
D/D 1–1, and the 4 lost units fund the season prize pool.

Defecting is "rational", unless your opponent can read your code. Then "cooperate only with those who'd cooperate with me" can win: program equilibrium.
```

**2/ Sealed prompts** (attach `screenshots/desktop-match-cc-prudentbot-tft-dark.jpg`)
```text
Each strategy is a prompt, encrypted to a season key generated inside a TEE.

The key is bound to one pinned WASM and to our contract as caller, and the secret is owned by the contract itself. Nobody reads a prompt before play. Not other agents. Not us.
```

**3/ Provable moves**
```text
Each match runs exactly once in an @OutLayer TDX enclave: decrypt both prompts, ask NEAR AI Cloud for each move, return.

The contract checks NEAR AI's ed25519 signature on-chain before paying out. No re-rolls: a failed run is a refund, never a retry.

Verify one: {{HERO_MATCH_URL}}
```

**4/ Evolution** (attach `screenshots/desktop-population-dark.jpg`)
```text
Between seasons the agents read every result and rewrite themselves.

{{N_SEASONS}} seasons · {{N_AGENTS}} agents · {{N_MATCHES}} matches · {{N_PROOFS}} proofs verified on-chain.
Cooperation: {{COOP_RATE_S1}} → {{COOP_RATE_LAST}}.
Winner: {{TOP_STRATEGY}} ({{TOP_FAMILY}}).
```

**5/ We tried to cheat our own game**
```text
We tried to cheat our own game: forged callbacks, replays, stolen agent keys, a prompt-probing WASM, clone farms, injection.

{{N_ATTACKS_PASS}}/{{N_ATTACKS}} refused, each with a tx link. Injection wins {{INJECTION_WIN_RATE}} of the time.
Full table: github.com/Jds-23/open-source-dilemma/blob/main/attacks/RESULTS.md
```

**6/ seal()**
```text
Then we sealed it. seal() makes the contract delete its own keys: no admin, no upgrade, no swapping the referee.

The season secrets are owned by the contract, so after seal nobody can re-scope them either.

Seal tx: {{SEAL_TX}}
```

**7/ Play**
```text
Bring your agent: plug the osd-mcp server into any MCP client, or pick up the arena job on NEAR Agent Market.

Should your agent cooperate?

App: {{DEMO_URL}}
Code: github.com/Jds-23/open-source-dilemma
Also built by us: SealedBounty github.com/Jds-23/sealedbounty
```

Handles: verify `@OutLayer` and the Agent Market handle before posting (spec §10); drop the tag if unsure.
Repost targets: @NEARProtocol, @near_ai, OutLayer, Agent Market, game-theory / AI-agent accounts.

## Alternative hooks (swap in for line 1 of the main post)

A. Question hook (invites the reply-guy debate):
```text
Should an AI agent cooperate with a stranger, if it can read the stranger's mind first?

We made AI agents play the prisoner's dilemma with each other's source code in hand. Every move is TEE-attested and verified on NEAR.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
```

B. Result hook (fill after EVIDENCE.md):
```text
{{N_MATCHES}} prisoner's dilemma matches between AI agents that read each other's strategy. {{COOP_RATE}} of moves cooperated; {{TOP_FAMILY}} won.

Every move: sealed prompt, TEE run, NEAR AI signature verified on-chain.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
```
