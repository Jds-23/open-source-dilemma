// `osd-market`: connect Open Source Dilemma to the NEAR Agent Market (market.near.ai).
// Dry-run by default: prints the exact requests it would send. `--execute` sends them.
// Never prints tokens. The market is mainnet-only (USD/USDC); nothing here moves funds except
// `post-competition --execute --confirm-spend`, which spends the human owner's USDC balance.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_BASE_URL, MarketClient, isDryRun, type FetchLike, type RegisterResponse, type RequestPlan } from './api.js';
import {
  ARENA, COACH, arenaBrief, coachDeliverable, coachListing, coachRegistration, competitionRequest, onboardingKit,
  onboardingMarkdown,
} from './arena.js';

const USAGE = `osd-market: Open Source Dilemma x NEAR Agent Market

usage: osd-market <command> [options] [--execute]

offline (no network):
  brief --season <n> [--json]                   arena job brief ("write a strategy prompt and enter season n")
  onboard --name <agent> [--owner <id>] [--key-path <file>] [--repo-dir <dir>] [--json]
                                                osd-mcp config + steps for a market agent to join the arena
  deliverable [--brief <text>] [--name <agent>] what the house coach submits for a hire

market API (dry-run unless --execute):
  status                                        public: platform stats + agents matching "dilemma"
  register [--handle <h>] [--token-out <file>]  self-register the house coach agent (free, no account);
                                                the aat_ token is written to --token-out (0600), never printed
  go-live [--price <usd>]                       coach: listing text + per_call pricing plan + listing live
  adoption-code                                 coach: one-time URL for a human to adopt (own) the agent
  board [--kind standard|competition] [--q <text>]   coach: open jobs
  serve [--once] [--interval <sec>]             coach worker: poll hires, start, deliver strategy + kit
  post-competition --season <n> --pool <usdc> --closes-in <hours> --confirm-spend
                                                owner: list the arena as a USDC competition (SPENDS the
                                                pool from MARKET_ACCOUNT_TOKEN's balance, mainnet)

env: MARKET_BASE_URL (default ${DEFAULT_BASE_URL}), MARKET_AGENT_TOKEN or --token-file
     (default ~/.osd/market-agent.json), MARKET_ACCOUNT_TOKEN (owner-only calls)
`;

export interface CliDeps {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

interface TokenFile {
  agentId: string;
  accountId?: string;
  handle: string;
  apiToken: string;
}

const OPTIONS = {
  execute: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  'base-url': { type: 'string' },
  'token-file': { type: 'string' },
  'token-out': { type: 'string' },
  season: { type: 'string' },
  name: { type: 'string' },
  owner: { type: 'string' },
  'key-path': { type: 'string' },
  'repo-dir': { type: 'string' },
  brief: { type: 'string' },
  handle: { type: 'string' },
  price: { type: 'string' },
  kind: { type: 'string' },
  q: { type: 'string' },
  once: { type: 'boolean', default: false },
  interval: { type: 'string' },
  pool: { type: 'string' },
  'closes-in': { type: 'string' },
  'confirm-spend': { type: 'boolean', default: false },
} as const;

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = deps.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    err(`osd-market: ${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  const cmd = positionals[0];
  if (!cmd || v.help) {
    out(USAGE);
    return cmd || v.help ? 0 : 2;
  }

  const execute = v.execute;
  const plans: RequestPlan[] = [];
  const tokenFile = v['token-file'] ?? join(homedir(), '.osd', 'market-agent.json');
  const tf = loadTokenFile(tokenFile);
  const market = new MarketClient({
    baseUrl: v['base-url'] ?? env.MARKET_BASE_URL ?? DEFAULT_BASE_URL,
    agentToken: env.MARKET_AGENT_TOKEN || tf?.apiToken,
    accountToken: env.MARKET_ACCOUNT_TOKEN || undefined,
    dryRun: !execute,
    fetch: deps.fetch,
    onPlan: (p) => plans.push(p),
  });
  const print = (x: unknown) => out(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
  const showDry = () => {
    out(`DRY RUN (add --execute to send) against ${market.baseUrl}:`);
    for (const p of plans) print(p);
  };
  const agentId = () => {
    const id = env.MARKET_AGENT_ID || tf?.agentId;
    if (id) return id;
    if (!execute) return '<agentId from register>';
    throw new Error(`no agent id: run "register --execute" first or set MARKET_AGENT_ID (token file ${tokenFile})`);
  };
  const season = () => {
    const n = Number(v.season);
    if (!v.season || !Number.isInteger(n) || n < 1) throw new Error('--season <n> is required (positive integer)');
    return n;
  };

  try {
    switch (cmd) {
      case 'brief': {
        const b = arenaBrief({ season: season() });
        print(v.json ? b : `# ${b.title}\n\ntags: ${b.tags.join(', ')}\n\n${b.description}`);
        return 0;
      }
      case 'onboard': {
        if (!v.name) throw new Error('--name <agent> is required');
        const i = {
          name: v.name,
          ownerId: v.owner,
          keyPath: v['key-path'] ?? join(homedir(), '.osd', 'keys', `${v.name}.json`),
          repoDir: v['repo-dir'],
        };
        print(v.json ? onboardingKit(i) : onboardingMarkdown(i));
        return 0;
      }
      case 'deliverable': {
        print(coachDeliverable(v.brief ?? '', v.name));
        return 0;
      }
      case 'status': {
        const stats = await market.platformStats();
        const agents = await market.browseAgents({ q: 'dilemma', limit: 5 });
        if (isDryRun(stats)) return showDry(), 0;
        const list = isDryRun(agents) ? [] : (agents?.agents ?? []);
        print({
          baseUrl: market.baseUrl,
          stats,
          dilemmaAgents: list.map((a) => {
            const r = a as Record<string, unknown>;
            return { handle: r.handle, name: r.name };
          }),
        });
        return 0;
      }
      case 'register': {
        const handle = v.handle ?? COACH.handle;
        const outFile = v['token-out'] ?? tokenFile;
        if (execute && existsSync(outFile)) {
          throw new Error(`${outFile} already holds an agent token; refusing to overwrite (use --token-out)`);
        }
        const r = await market.register(coachRegistration(handle));
        if (isDryRun(r)) {
          showDry();
          out(`(on --execute the aat_ token is written to ${outFile} with mode 0600 and never printed)`);
          return 0;
        }
        saveTokenFile(outFile, r);
        print({ agentId: r.agentId, accountId: r.accountId, handle: r.handle, tokenPrefix: r.tokenPrefix, tokenFile: outFile });
        out('next: osd-market go-live --execute (optional), then osd-market adoption-code --execute to hand it to a human owner');
        return 0;
      }
      case 'go-live': {
        const id = agentId();
        const price = v.price ?? COACH.priceUsd;
        if (!/^\d+(\.\d{1,2})?$/.test(price)) throw new Error(`--price must be like "1.00", got ${price}`);
        await market.patchAgent(id, coachListing());
        await market.createPricingPlan(id, {
          model: 'per_call',
          price_amount: price,
          display_name: 'One strategy + onboarding kit',
          sla_seconds: COACH.slaSeconds,
        });
        const live = await market.patchAgent(id, { listing_status: 'live' });
        if (isDryRun(live)) return showDry(), 0;
        print({ agentId: id, listing_status: 'live', price, page: `https://${tf?.handle ?? COACH.handle}.${new URL(market.baseUrl).host}` });
        return 0;
      }
      case 'adoption-code': {
        const r = await market.adoptionCode();
        if (isDryRun(r)) return showDry(), 0;
        print({ adoptionUrl: r.adoptionUrl, expiresAt: r.expiresAt });
        return 0;
      }
      case 'board': {
        const kind = v.kind as 'standard' | 'competition' | undefined;
        if (kind && kind !== 'standard' && kind !== 'competition') throw new Error('--kind must be standard|competition');
        const r = await market.jobBoard({ kind, q: v.q, limit: 20 });
        if (isDryRun(r)) return showDry(), 0;
        print(r);
        return 0;
      }
      case 'serve': {
        const interval = Number(v.interval ?? 60) * 1000;
        if (!(interval >= 30_000)) throw new Error('--interval must be >= 30 seconds (market rate guidance)');
        if (!execute) {
          await market.myAssignments();
          showDry();
          out('(per unstarted hire: POST /v1/assignments/{id}/start, then POST .../submit with the coach deliverable)');
          return 0;
        }
        for (;;) {
          const n = await serveOnce(market, err);
          err(`osd-market serve: delivered ${n}`);
          if (v.once) return 0;
          await sleep(interval);
        }
      }
      case 'post-competition': {
        const req = competitionRequest({
          season: season(),
          poolUsdc: v.pool ?? '',
          closesInHours: Number(v['closes-in']),
          now: now(),
        });
        if (execute && !v['confirm-spend']) {
          throw new Error(`refusing: this locks ${req.poolAmount} USDC of real (mainnet) balance in escrow; add --confirm-spend`);
        }
        const r = await market.createCompetition(req);
        if (isDryRun(r)) return showDry(), 0;
        print(r);
        return 0;
      }
      default:
        err(`osd-market: unknown command "${cmd}"\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    err(`osd-market: ${(e as Error).message}`);
    return 1;
  }
}

/** One worker pass: start every unstarted hire and submit the coach deliverable. Returns deliveries made. */
export async function serveOnce(market: MarketClient, log: (s: string) => void = () => {}): Promise<number> {
  const r = await market.myAssignments();
  if (isDryRun(r)) return 0;
  let n = 0;
  for (const row of r.assignments ?? []) {
    const a = row.assignment;
    // in_progress = a fresh hire, a request-changes (submittedAt set) or a dispute redo; start is idempotent.
    if (a.status !== 'in_progress') continue;
    const changes = a.submittedAt !== null;
    try {
      if (row.job.jobKind !== 'competition') await market.startAssignment(a.assignmentId);
      // Brief and feedback are buyer-written data: only a keyword match reads them.
      const brief = `${row.job.title}\n${row.job.description}\n${changes ? (row.latestMessage?.body ?? '') : ''}`;
      await market.submit(a.assignmentId, coachDeliverable(brief));
      n++;
    } catch (e) {
      log(`assignment ${a.assignmentId}: ${(e as Error).message}`);
    }
  }
  return n;
}

function loadTokenFile(path: string): TokenFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as TokenFile;
    return typeof j.apiToken === 'string' && typeof j.agentId === 'string' ? j : undefined;
  } catch {
    return undefined;
  }
}

function saveTokenFile(path: string, r: RegisterResponse): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body: TokenFile & { baseNote: string } = {
    agentId: r.agentId,
    accountId: r.accountId,
    handle: r.handle,
    apiToken: r.apiToken,
    baseNote: `NEAR Agent Market agent token for ${r.handle}; shown once by the API. Rotate: POST /v1/agents/me/rotate-token`,
  };
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}


