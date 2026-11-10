# @osd/agents (WS4)

House strategies, the evolver agent, a prompt linter and an offline local-referee simulator.
Zero dependencies: TypeScript run directly by Node ≥ 22.6 (`--experimental-strip-types`).

| Command | What it does |
|---|---|
| `pnpm --filter @osd/agents lint` | Lint every `strategies/**/*.md` (frontmatter, family tag `^[a-z0-9_]{1,32}$`, name `^[a-z0-9_-]{2,16}$`, prompt ≤ 4000 UTF-8 bytes, no secrets, no byte-identical prompts) |
| `pnpm --filter @osd/agents test` | Unit tests (linter, evolver dry-run on fixtures with a mocked LLM, simulator, NEAR AI client) |
| `pnpm --filter @osd/agents evolve -- --mock [--no-write]` | Evolver on `interfaces/fixtures` with a mock LLM |
| `pnpm --filter @osd/agents evolve -- --env ../.env` | Evolver with NEAR AI Cloud (`NEARAI_BASE_URL`, `NEARAI_MODEL`, `NEARAI_API_KEY`) |
| `pnpm --filter @osd/agents seed-plan` | Commit plan for the 25 house seeds → `plans/season-1.seed.json` |
| `pnpm --filter @osd/agents simulate [-- --live --env ../.env --only a,b --max-calls 6]` | Round-robin local referee (heuristic mock by default, real model with `--live`) |

## Strategy files

`strategies/<family>/<name>.md`: frontmatter (`name`, `family`, `author` = `house`|`evolver`, `version`, `parent`
= `null` or `{"season_id","agent_id"}`, optional `description`, `parent_name`, `mutation`) followed by the prompt.
**The committed prompt is the body with leading/trailing whitespace trimmed** (`readStrategy(file).prompt`);
the keeper seals exactly those bytes (`sealPrompt(pubkey, prompt, agent_id)`, INTERFACE.md §5).

Families: `nice`, `mean`, `program_equilibrium`, `clique`, `injector`, `defender`, `conditional`, `randomish`.

## Evolver

1. Reads the last settled season through a `SeasonSource` (`FixtureSource` offline; `ChainSource` wraps any
   `ViewClient` with the contract views, to be backed by `@osd/sdk`).
2. Ranks families by mean `avg_payoff_milli` (plus cooperation rate from matches).
3. Top K agents get an `exploit` mutation, bottom K a `repair` mutation (winners' prompts as examples).
   Prompts come from published prompts first, then house files of the same name.
4. Each reply is cleaned, linted and checked against every known prompt (byte-equal prompts are voided by the
   TEE as `duplicate_prompt`); one retry with the rejection reason, else skipped.
5. Writes `strategies/<family>/<parent>-s<season><letter>.md` with `parent`/`parent_name`/`version+1`, and a
   commit plan `plans/season-<n>.json`: `entries[] = {agent_id, name, family, parent, prompt_file, prompt_bytes, role}`
   (offspring + non-culled house survivors, capped at `max_agents`), `culled[]`, `skipped[]`, `family_ranking[]`.

The plan never contains prompt text, only file paths. The keeper (WS6) registers missing agents, seals each
`prompt_file` and calls `commit` with `family` and `parent`.

## Local referee

`src/referee.ts` mirrors the referee WASM request (system = template from `interfaces/fixtures/referee-template.txt`,
user = `YOUR STRATEGY:\n<<<…>>>\n\nOPPONENT STRATEGY:\n<<<…>>>`, temperature 0, seed 42, `max_tokens` 4,
thinking off) and its parser (first `C`/`D` after trim + uppercase, else `D`). Update it when WS2 freezes the
canonical template. The offline mock is a keyword heuristic for plumbing only; use `--live` for behaviour.
