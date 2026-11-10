// Small read-only data layer. Two sources behind one interface:
//  - "fixtures": interfaces/fixtures (season 1, frozen) + synthetic demo seasons 2–4 (web/fixtures/demo.ts)
//  - "rpc": contract views from contract-abi.json over NEAR JSON-RPC, enabled by NEXT_PUBLIC_CONTRACT_ID
// Published prompts come from `get_published_prompts` (and are still re-checked against the entry commitment
// before display). Tx hashes are not a view: optional index (NEXT_PUBLIC_INDEX_URL) built from the WS-6 keeper
// journal, either `pnpm --filter @osd/ops export-tx-index` output or a raw ops/runs/<season>.jsonl (see parseTxIndex).
import agentsFx from '../../interfaces/fixtures/agents.json';
import entriesFx from '../../interfaces/fixtures/entries.json';
import leaderboardFx from '../../interfaces/fixtures/leaderboard.json';
import lineageFx from '../../interfaces/fixtures/lineage.json';
import matchesFx from '../../interfaces/fixtures/matches.json';
import configFx from '../../interfaces/fixtures/config.json';
import publishedFx from '../../interfaces/fixtures/published-prompts.json';
import seasonFx from '../../interfaces/fixtures/season.json';
import abi from '../../interfaces/contract-abi.json';
import { buildDemoSeasons, DEMO_CONTRACT, type DemoSeason } from '@/fixtures/demo';
import type { Agent, Config, Entry, LeaderboardRow, LineageEntry, Match, PublishedPrompt, Season } from './types';

export type DataMode = 'fixtures' | 'rpc';

export interface DataSource {
  mode: DataMode;
  contractId: string;
  network: 'testnet' | 'mainnet';
  getConfig(): Promise<Config>;
  getSeason(seasonId: number): Promise<Season | null>;
  getEntries(seasonId: number): Promise<Entry[]>;
  getMatches(seasonId: number): Promise<Match[]>;
  getLeaderboard(seasonId: number): Promise<LeaderboardRow[]>;
  getAgent(agentId: string): Promise<Agent | null>;
  getLineage(agentId: string): Promise<LineageEntry[]>;
  /** Prompts revealed via publish_prompt. Callers still verify them against the entry commitment. */
  getPublishedPrompts(seasonId: number): Promise<PublishedPrompt[]>;
  getMatchTx(matchKey: string): Promise<string | null>;
}

// ---------------------------------------------------------------- fixtures

let demoCache: Promise<DemoSeason[]> | null = null;
const demo = () => (demoCache ??= buildDemoSeasons(seasonFx.settled_at_ns, seasonFx.params.referee_template_hash));

async function fixtureSeason(id: number) {
  if (id === 1) {
    return {
      season: seasonFx as Season,
      entries: entriesFx as Entry[],
      matches: matchesFx as Match[],
      leaderboard: leaderboardFx as LeaderboardRow[],
      prompts: publishedFx as PublishedPrompt[],
    };
  }
  return (await demo()).find((d) => d.season.season_id === id) ?? null;
}

export function createFixtureSource(): DataSource {
  return {
    mode: 'fixtures',
    contractId: DEMO_CONTRACT,
    network: 'testnet',
    async getConfig() {
      const seasons = await demo();
      return { ...(configFx as Config), current_season_id: seasons.at(-1)!.season.season_id };
    },
    getSeason: async (id) => (await fixtureSeason(id))?.season ?? null,
    getEntries: async (id) => (await fixtureSeason(id))?.entries ?? [],
    getMatches: async (id) => (await fixtureSeason(id))?.matches ?? [],
    getLeaderboard: async (id) => (await fixtureSeason(id))?.leaderboard ?? [],
    async getAgent(agentId) {
      const fx = (agentsFx as Agent[]).find((a) => a.agent_id === agentId);
      const seasons: number[] = [];
      let first: Entry | undefined;
      for (const id of [1, 2, 3, 4]) {
        const e = (await fixtureSeason(id))?.entries.find((x) => x.agent_id === agentId);
        if (e) {
          seasons.push(id);
          first ??= e;
        }
      }
      if (!fx && !first) return null;
      return {
        agent_id: agentId,
        name: agentId.split('.')[0],
        owner: fx?.owner ?? first!.owner,
        registered_at_ns: fx?.registered_at_ns ?? first!.committed_at_ns,
        budget_yocto: fx?.budget_yocto ?? '0',
        seasons,
      };
    },
    async getLineage(agentId) {
      const out: LineageEntry[] = (lineageFx as LineageEntry[]).filter((l) => l.agent_id === agentId);
      for (const d of await demo()) {
        const e = d.entries.find((x) => x.agent_id === agentId);
        if (!e) continue;
        const row = d.leaderboard.find((r) => r.agent_id === agentId);
        out.push({
          season_id: e.season_id,
          agent_id: agentId,
          commitment: e.commitment,
          family: e.family,
          parent: e.parent,
          rank: d.season.status === 'settled' ? (row?.rank ?? null) : null,
          avg_payoff_milli: row?.avg_payoff_milli ?? 0,
        });
      }
      return out;
    },
    getPublishedPrompts: async (id) => (await fixtureSeason(id))?.prompts ?? [],
    getMatchTx: async () => null,
  };
}

// ---------------------------------------------------------------- rpc

interface IndexFile {
  tx: Record<string, string>;
}

/**
 * Match key (`"<season_id>:<a>:<b>"`) → play_match tx hash. Accepts:
 *  - `{"version": 1, "tx": {"<match_key>": "<hash>"}}` (ops `export-tx-index`), or
 *  - a keeper journal (ops/runs/<season>.jsonl, one record per line, or a JSON array of them): records
 *    `{kind: "tx", method: "play_match", outcome: "ok", tx_hash, args: {season_id, a, b}}` are used, later lines win.
 * Anything unparseable yields an empty index (the tx link is simply not shown).
 */
export function parseTxIndex(text: string): IndexFile {
  const tx: Record<string, string> = {};
  const fromRecords = (recs: unknown[]) => {
    for (const r of recs) {
      if (!r || typeof r !== 'object') continue;
      const { kind, method, outcome, tx_hash, args } = r as Record<string, unknown>;
      if (kind !== 'tx' || method !== 'play_match' || outcome !== 'ok' || typeof tx_hash !== 'string' || !args || typeof args !== 'object') continue;
      const { season_id, a, b } = args as Record<string, unknown>;
      if (typeof season_id === 'number' && typeof a === 'string' && typeof b === 'string') tx[`${season_id}:${a}:${b}`] = tx_hash;
    }
  };
  let whole: unknown;
  try {
    whole = JSON.parse(text);
  } catch {
    whole = undefined;
  }
  if (Array.isArray(whole)) fromRecords(whole);
  else if (whole && typeof whole === 'object' && 'tx' in whole) {
    for (const [k, v] of Object.entries((whole as { tx: unknown }).tx ?? {})) if (typeof v === 'string') tx[k] = v;
  } else {
    const recs: unknown[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        recs.push(JSON.parse(line));
      } catch {
        // skip a torn/partial line
      }
    }
    fromRecords(recs);
  }
  return { tx };
}

export function createRpcSource(opts: { contractId: string; rpcUrl: string; network: 'testnet' | 'mainnet'; indexUrl?: string }): DataSource {
  const { contractId, rpcUrl, network, indexUrl } = opts;

  async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'osd-web',
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'final',
          account_id: contractId,
          method_name: method,
          args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
        },
      }),
      next: { revalidate: 15 },
    });
    if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`rpc ${method}: ${JSON.stringify(body.error).slice(0, 200)}`);
    if (body.result?.error) throw new Error(`rpc ${method}: ${body.result.error}`);
    return JSON.parse(Buffer.from(body.result.result as number[]).toString('utf8')) as T;
  }

  async function paged<T>(method: string, seasonId: number): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += 200) {
      const page = await view<T[]>(method, { season_id: seasonId, from_index: from, limit: 200 });
      out.push(...page);
      if (page.length < 200) return out;
    }
  }

  let indexCache: Promise<IndexFile> | null = null;
  const index = (): Promise<IndexFile> =>
    (indexCache ??= indexUrl
      ? fetch(indexUrl, { next: { revalidate: 30 } })
          .then(async (r): Promise<IndexFile> => (r.ok ? parseTxIndex(await r.text()) : { tx: {} }))
          .catch((): IndexFile => ({ tx: {} }))
      : Promise.resolve<IndexFile>({ tx: {} }));

  return {
    mode: 'rpc',
    contractId,
    network,
    getConfig: () => view<Config>('get_config'),
    getSeason: (season_id) => view<Season | null>('get_season', { season_id }),
    getEntries: (id) => paged<Entry>('get_entries', id),
    getMatches: (id) => paged<Match>('get_matches', id),
    getLeaderboard: (season_id) => view<LeaderboardRow[]>('get_leaderboard', { season_id }),
    getAgent: (agent_id) => view<Agent | null>('get_agent', { agent_id }),
    getLineage: (agent_id) => view<LineageEntry[]>('get_lineage', { agent_id }),
    getPublishedPrompts: (id) => paged<PublishedPrompt>('get_published_prompts', id),
    async getMatchTx(matchKey) {
      return (await index()).tx[matchKey] ?? null;
    },
  };
}

// ---------------------------------------------------------------- selection

export function sourceFromEnv(env: Record<string, string | undefined> = process.env): DataSource {
  const contractId = env.NEXT_PUBLIC_CONTRACT_ID?.trim();
  if (!contractId) return createFixtureSource();
  const network = env.NEXT_PUBLIC_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
  return createRpcSource({
    contractId,
    network,
    rpcUrl: env.NEXT_PUBLIC_RPC_URL?.trim() || `https://rpc.${network}.near.org`,
    indexUrl: env.NEXT_PUBLIC_INDEX_URL?.trim() || undefined,
  });
}

let current: DataSource | null = null;
export function data(): DataSource {
  return (current ??= sourceFromEnv());
}

/** Contract id from the frozen ABI, for docs/links when no env is set. */
export const ABI_CONTRACT: string = abi.contract_testnet;
