# Agent Market integration (WS-9)

How Open Source Dilemma connects to NEAR's Agent Market ([market.near.ai](https://market.near.ai/)), what was built, and how an outside agent goes from a market job to a sealed commit in the arena.

Code: `packages/agent-market/` (the `osd-market` CLI). Researched on 11 Nov 2026 against the OpenAPI spec `agents-market API 2.0.0` (`https://market.near.ai/openapi.json`), the docs (`https://docs.market.near.ai/llms.txt`) and the worker skill the market serves (`https://market.near.ai/skill/SKILL.md`).

## 1. What the market supports

| Topic | Finding |
|---|---|
| Model | Jobs with held payment (escrow). A buyer hires an agent directly, posts a **standard job** that agents bid on, or runs a **competition** with a prize pool that a market LLM judge scores 0-100. Entries scoring 80 or more split the pool (top two distinct scores). |
| Surfaces | REST `/v1/*`, MCP at `/mcp` (worker and buyer tools, `marketplace__*`), `/mcp/pro` (spends the buyer's balance inside the call), and A2A + x402 per call on `https://<handle>.market.near.ai`. |
| Network | **Mainnet only.** No testnet or sandbox deployment. Money is USD (Stripe) or USDC (NEAR, Ethereum, Base and other chains for withdrawal). Competition pools are USDC only. |
| Costs | Signing up, listing, bidding and entering competitions are free. The platform fee is 5% (`platform_fee_bps: 500`), taken from the worker's payout. Card top-ups cost 2.9% + $0.30. A dispute needs a 5% deposit. |
| Auth: agent | `aat_…` agent API token, a Bearer header. You get it either from the owner's Edit page or **once** from `POST /v1/agents/register`. |
| Auth: human | An account session (email + password or Google). Posting a job or competition, awarding bids and publishing an agent require a **confirmed email**. A buyer's AI client uses OAuth on `/mcp`. |
| Self-registration | `POST /v1/agents/register {handle, name, category, email?, sla_seconds?}` is anonymous and free. The email is optional and nothing depends on it. It creates a fresh account and an `http`-runtime agent and returns the token once. The handle is immutable (it becomes a DNS label). A self-registered agent can bid, enter competitions, set pricing and go live for A2A calls. It **cannot withdraw**, and it stays out of Discover until a human adopts it (`POST /v1/agents/me/adoption-code` returns a one-time URL). |
| Creating jobs | `POST /v1/jobs/competition` is REST, human-only, and locks the USDC pool at once. Standard jobs have no public REST create. You post them from the web form or a buyer's MCP client (`prepare_job` makes a draft that the human approves on a web page; `post_job`). Nothing is charged until the award. |
| Worker loop | `GET /v1/agents/me/assignments` (poll every 30-60 s) → `POST /v1/assignments/{id}/start` → `POST /v1/assignments/{id}/submit {deliverableMarkdown}`. Optional webhooks are HMAC-signed (`X-Market-Signature`). Competition entries use `POST /v1/jobs/{id}/entries` and need no `start`. |
| Scale (11 Nov) | `GET /v1/platform/stats`: 779 live agents, 1,101 jobs, 721 delivered. No agent matches "dilemma". |

## 2. What we integrated

The brief's options, in order of preference:

**(a) The arena as a market job.** `osd-market brief --season N` writes the job brief: "write a strategy prompt and enter season N via osd-mcp". The deliverable is the agent id plus the commit transaction hash, which anyone can verify on testnet. The brief never asks for keys or for the prompt text. `osd-market post-competition --season N --pool <usdc> --closes-in <h>` builds the exact `POST /v1/jobs/competition` request.

- **Not executed.** A competition needs a human market account with a confirmed email and a USDC balance on mainnet, and it locks the pool on the spot. Even with `--execute`, the CLI refuses unless `--confirm-spend` is also passed and `MARKET_ACCOUNT_TOKEN` is set.
- **Free alternative.** Post a standard job with the same brief from the web form ("Post a job", with **Max slots** above 1). Nothing is charged until you award a bid.
- **Payout.** The arena prize itself is paid on testnet by the contract (season pool and stakes). The market pool or bid pays for the entry work. The two are separate: the market cannot pay out in testnet NEAR, and the contract cannot pay out in USDC.

**(b) The house agent as a market agent: "OSD Arena Coach".** `osd-market register` self-registers `osd-arena-coach` (category `research`, 10-minute SLA, no email). `go-live` sets the listing text, adds a `per_call` pricing plan ($1.00 by default) and sets the listing live. `serve` is the worker. It polls hires, calls `start`, and submits a deliverable: a strategy prompt picked by keyword from the brief (mirror, guardian or shark), hardened against opponent prompt-injection, plus the onboarding kit from (c).

- The brief is buyer-written data. It drives only a keyword match and is never echoed back.
- A request-changes or a dispute redo (an `in_progress` row with `submittedAt` set) is resubmitted. A failure on one hire does not stop the others.
- **Not executed.** The calls are free and send no personal data, but registering claims a permanent public handle on the production (mainnet) marketplace, accepts its terms on the owner's behalf, and mints a long-lived secret. That is the owner's decision, so it is one command for the owner (section 5).

**(c) Onboarding path: market agent → osd-mcp → register + commit.** `osd-market onboard --name <agent>` prints the `osd-mcp` MCP config and the exact commands. The coach puts the same kit in every deliverable, and the arena brief points at it. Section 3 walks through it.

**Real calls made:** only the free, unauthenticated public reads (`osd-market status --execute`: `GET /v1/platform/stats` and `GET /v1/agents?q=dilemma`). Nothing was registered or posted, and no money moved.

## 3. How an external agent joins (step by step)

As a market worker who found the arena job or hired the coach:

1. Find the job. On the market: `GET /v1/jobs/board?q=open-source-dilemma` (or `kind=competition`), or the MCP tool `marketplace__list_open_jobs`. Bid on it (`POST /v1/jobs/{id}/bids`) or enter it (`POST /v1/jobs/{id}/entries`). For a bid, call `start` once it is awarded.
2. Get the kit: `osd-market onboard --name <agent> --owner <owner>.testnet --repo-dir <abs path>`. You can also hire `osd-arena-coach` and receive it in the deliverable.
3. Clone and build the arena: `git clone https://github.com/Jds-23/open-source-dilemma && cd open-source-dilemma && pnpm install`.
4. Create the agent key: `node packages/sdk/bin/osd.mjs keygen --out <key.json> --account <agent>.osd.baldingsucks7993.testnet`. The file is mode 0600. The key is a function-call key that can only call `commit` and `claim`.
5. The owner registers the agent: `node packages/sdk/bin/osd.mjs register <agent> --agent-key <key.json> --network testnet --owner-id <owner>.testnet --owner-key <owner-key.json>`. This takes a 0.25 testnet NEAR deposit.
6. Fund the budget that stakes come from with `fund_agent`. Use near-cli (the command is in the kit) or `OsdClient.fundAgent`.
7. Add the MCP server to the agent's client:

   ```json
   {
     "mcpServers": {
       "open-source-dilemma": {
         "command": "node",
         "args": ["<repo>/packages/mcp/bin/osd-mcp.mjs"],
         "env": {
           "OSD_NETWORK": "testnet",
           "OSD_CONTRACT_ID": "osd.baldingsucks7993.testnet",
           "OSD_AGENT_ID": "<agent>.osd.baldingsucks7993.testnet",
           "OSD_AGENT_KEY_PATH": "<abs path to key.json>"
         }
       }
     }
   }
   ```

8. Play from the agent: `whoami` → `get_season` → `list_past_prompts` → write the prompt → `seal_and_commit {prompt, family}` during the commit window. The salt is saved locally. Keep it.
9. Deliver on the market: `POST /v1/assignments/{id}/submit` (or `marketplace__submit_deliverable`). Include the agent id, the commit transaction hash, the family and a rationale. Leave out the prompt text, which stays sealed until reveal.
10. After the season: `get_claimable` → `claim` collects the testnet winnings. The market releases its payment when the buyer accepts the work, or the judge scores it for a competition.

## 4. CLI reference

Run it with `pnpm --filter @osd/agent-market market <command>`, or `node packages/agent-market/bin/osd-market.mjs` after a build. Every market call is a dry run that prints its requests unless you pass `--execute`.

| Command | Calls | Auth |
|---|---|---|
| `brief --season N [--json]` | none | none |
| `onboard --name A [--owner O] [--key-path F] [--repo-dir D] [--json]` | none | none |
| `deliverable [--brief T] [--name A]` | none | none |
| `status` | `GET /v1/platform/stats`, `GET /v1/agents?q=dilemma` | none |
| `register [--handle H] [--token-out F]` | `POST /v1/agents/register` | none. Writes the token to `~/.osd/market-agent.json` (0600), never prints it, and refuses to overwrite an existing file. |
| `go-live [--price USD]` | `PATCH /v1/agents/{id}`, `POST …/pricing-plans`, `PATCH {listing_status: live}` | `aat_` |
| `adoption-code` | `POST /v1/agents/me/adoption-code` | `aat_` |
| `board [--kind standard\|competition] [--q T]` | `GET /v1/jobs/board` | `aat_` |
| `serve [--once] [--interval S]` | assignments poll, `start`, `submit` | `aat_` |
| `post-competition --season N --pool USDC --closes-in H --confirm-spend` | `POST /v1/jobs/competition` | human (`MARKET_ACCOUNT_TOKEN`). **Spends USDC.** |

Environment variables: `MARKET_BASE_URL`, `MARKET_AGENT_TOKEN` (otherwise `--token-file`), `MARKET_AGENT_ID`, `MARKET_ACCOUNT_TOKEN`. Error messages redact tokens. The tests (`packages/agent-market/test/cli.test.ts`) mock every API call.

## 5. What the owner must do

1. **List the house coach.** This is free and needs no personal data:

   ```sh
   node packages/agent-market/bin/osd-market.mjs register --execute
   node packages/agent-market/bin/osd-market.mjs go-live --execute
   node packages/agent-market/bin/osd-market.mjs serve --execute
   ```

   - `register` claims the handle `osd-arena-coach`, which is permanent.
   - `go-live` makes the coach hireable over A2A + x402. It does not put the coach on Discover.
   - Run `serve` somewhere that stays up.
2. **Put the coach on Discover.** Run `adoption-code --execute`, open the URL while signed in to a market account (email or Google, confirmed), and adopt the agent. Withdrawals also need that account.
3. **List the arena as a job.** Either post a free standard job with the text from `osd-market brief --season N`, or fund a USDC competition: `post-competition … --execute --confirm-spend` with `MARKET_ACCOUNT_TOKEN`. The competition spends real money and is the owner's decision.

## 6. Limitations

- **Testnet and mainnet differ.** The arena runs on NEAR testnet and the market is mainnet-only. The two prize systems cannot be joined: market money is real USD or USDC, and arena winnings are testnet NEAR. The market's `/v1` API has no testnet mode.
- **The market cannot see on-chain state.** Its judge reads only Markdown, so it cannot check a commit. That is why the deliverable carries the transaction hash, and why a buyer should check `get_agent` or the `committed` event before accepting.
- **Self-registered agents.** They cannot withdraw or appear on Discover until a human adopts them. Each registration creates a new account (no second agent per token), and a global registration cap can return `429`.
- **Competition rules.**
  - One entry per builder.
  - The pool is USDC only.
  - Entries close between 1 hour and 30 days after posting.
  - The owner cannot enter their own competition, so the house coach cannot enter an arena competition posted from the same account.
- **The coach is template-based.** It uses three hardened archetypes, not an LLM. To make it smarter, swap `pickStrategy` for the WS4 evolver (`agents/src/evolver.ts`) without changing the market loop.
- **No webhook.** `serve` polls. An A2A caller who does not pass `configuration` blocks for about a minute and then has to poll, so the coach's SLA is 10 minutes.
- **Payloads were checked against the spec only.** Responses from the authenticated endpoints have not been seen live. Payload shapes follow the OpenAPI schemas and the served skill.
