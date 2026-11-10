// Small read-only data layer. Two sources behind one interface:
//  - "fixtures": interfaces/fixtures (season 1, frozen) + synthetic demo seasons 2–4 (web/fixtures/demo.ts)
//  - "rpc": contract views from contract-abi.json over NEAR JSON-RPC, enabled by NEXT_PUBLIC_CONTRACT_ID
// Published prompts and tx hashes are not contract views; in rpc mode they come from an optional JSON index
// (NEXT_PUBLIC_INDEX_URL), and every prompt is re-checked against the on-chain commitment before display.
import agentsFx from '../../interfaces/fixtures/agents.json';
import entriesFx from '../../interfaces/fixtures/entries.json';
import leaderboardFx from '../../interfaces/fixtures/leaderboard.json';
import lineageFx from '../../interfaces/fixtures/lineage.json';
import matchesFx from '../../interfaces/fixtures/matches.json';
import promptsFx from '../../interfaces/fixtures/prompts.json';
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
  /** Unverified candidate; callers must check it against the entry commitment. */
  getPublishedPrompt(seasonId: number, agentId: string): Promise<PublishedPrompt | null>;
  getMatchTx(matchKey: string): Promise<string | null>;
}

// ---------------------------------------------------------------- fixtures

let demoCache: Promise<DemoSeason[]> | null = null;
const demo = () => (demoCache ??= buildDemoSeasons(seasonFx.settled_at_ns));

async function fixtureSeason(id: number) {
  if (id === 1) {
    return {
      season: seasonFx as Season,
      entries: entriesFx as Entry[],
      matches: matchesFx as Match[],
      leaderboard: leaderboardFx as LeaderboardRow[],
      prompts: (promptsFx as Array<PublishedPrompt & { published: boolean }>).filter((p) => p.published),
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
      const deployer = DEMO_CONTRACT.split('.').slice(1).join('.'); // contract parent account
      return {
        owner: deployer,
        outlayer_account: 'outlayer.testnet',
        wasm_url: seasonFx.wasm.url,
        wasm_hash: seasonFx.wasm.hash,
        secrets_owner: deployer,
        secrets_profile: 'osd',
        nearai_signer: '',
        current_season_id: seasons.at(-1)!.season.season_id,
      };
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
    async getPublishedPrompt(seasonId, agentId) {
      return (await fixtureSeason(seasonId))?.prompts.find((p) => p.agent_id === agentId) ?? null;
    },
    getMatchTx: async () => null,
  };
}

// ---------------------------------------------------------------- rpc

interface IndexFile {
  tx?: Record<string, string>;
  prompts?: PublishedPrompt[];
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
          .then((r): Promise<IndexFile> | IndexFile => (r.ok ? r.json() : {}))
          .catch((): IndexFile => ({}))
      : Promise.resolve<IndexFile>({}));

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
    async getPublishedPrompt(seasonId, agentId) {
      return (await index()).prompts?.find((p) => p.season_id === seasonId && p.agent_id === agentId) ?? null;
    },
    async getMatchTx(matchKey) {
      return (await index()).tx?.[matchKey] ?? null;
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
