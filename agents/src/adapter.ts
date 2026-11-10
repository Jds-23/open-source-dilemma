// Season data adapter. The evolver only talks to `SeasonSource`, so the offline fixture
// source can later be swapped for @osd/sdk (WS3) without touching evolver logic.
// Types mirror interfaces/contract-abi.json ($defs) at interfaces-v2.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, type Parent } from './strategy.ts';

export type Move = 'C' | 'D' | 'F';

export interface SeasonParams {
  commit_deadline_ns: string;
  play_deadline_ns: string;
  unit_yocto: string;
  bond_yocto: string;
  max_agents: number;
  max_entries_per_owner: number;
  referee_template_hash: string;
  model: string;
  prize_split_bps: number[];
}

export interface Season {
  season_id: number;
  status: string;
  params: SeasonParams;
  n_entries: number;
  [k: string]: unknown;
}

export interface Entry {
  season_id: number;
  agent_id: string;
  owner: string;
  family: string;
  parent: Parent | null;
  commitment: string;
  ciphertext_hex: string;
  committed_at_ns: string;
}

export interface Match {
  season_id: number;
  a: string;
  b: string;
  round: number;
  status: string;
  a_move: Move | null;
  b_move: Move | null;
  a_payoff: number | null;
  b_payoff: number | null;
  void_reason: string | null;
  [k: string]: unknown;
}

export interface LeaderboardRow {
  agent_id: string;
  owner: string;
  family: string;
  matches_counted: number;
  total_payoff_counted: number;
  avg_payoff_milli: number;
  rank: number | null;
  prize_yocto: string;
}

export interface SeasonData {
  season: Season;
  entries: Entry[];
  matches: Match[];
  leaderboard: LeaderboardRow[];
  /** agent_id → prompt text, for prompts published after settlement (`publish_prompt`) or known locally. */
  prompts: Map<string, string>;
}

export interface SeasonSource {
  readonly label: string;
  latestSettledSeasonId(): Promise<number>;
  loadSeason(seasonId: number): Promise<SeasonData>;
}

export const FIXTURES_DIR = join(REPO_ROOT, 'interfaces', 'fixtures');

/** Offline source backed by interfaces/fixtures (one settled season). */
export class FixtureSource implements SeasonSource {
  readonly label: string;
  private readonly dir: string;
  constructor(dir: string = FIXTURES_DIR) {
    this.dir = dir;
    this.label = `fixtures:${dir}`;
  }
  private read<T>(name: string): T {
    return JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as T;
  }
  async latestSettledSeasonId(): Promise<number> {
    const s = this.read<Season>('season.json');
    if (s.status !== 'settled') throw new Error(`fixture season ${s.season_id} is not settled`);
    return s.season_id;
  }
  async loadSeason(seasonId: number): Promise<SeasonData> {
    const season = this.read<Season>('season.json');
    if (season.season_id !== seasonId) throw new Error(`fixtures only contain season ${season.season_id}`);
    const prompts = new Map<string, string>();
    if (existsSync(join(this.dir, 'prompts.json'))) {
      for (const p of this.read<Array<{ season_id: number; agent_id: string; prompt: string; published?: boolean }>>('prompts.json')) {
        if (p.season_id === seasonId && p.published !== false) prompts.set(p.agent_id, p.prompt);
      }
    }
    return {
      season,
      entries: this.read<Entry[]>('entries.json').filter((e) => e.season_id === seasonId),
      matches: this.read<Match[]>('matches.json').filter((m) => m.season_id === seasonId),
      leaderboard: this.read<LeaderboardRow[]>('leaderboard.json'),
      prompts,
    };
  }
}

/**
 * The subset of contract views (INTERFACE.md §6.2) the evolver needs. @osd/sdk's read client is
 * expected to satisfy this shape; until it lands, any object with these methods works (tests use a fake).
 */
export interface ViewClient {
  getConfig(): Promise<{ current_season_id: number }>;
  getSeason(seasonId: number): Promise<Season | null>;
  getEntries(seasonId: number, fromIndex?: number, limit?: number): Promise<Entry[]>;
  getMatches(seasonId: number, fromIndex?: number, limit?: number): Promise<Match[]>;
  getLeaderboard(seasonId: number): Promise<LeaderboardRow[]>;
}

/** Live source: contract views via a ViewClient + locally known prompts (house files / published prompts). */
export class ChainSource implements SeasonSource {
  readonly label = 'chain';
  private readonly client: ViewClient;
  private readonly knownPrompts: Map<string, string>;
  constructor(client: ViewClient, knownPrompts: Map<string, string> = new Map()) {
    this.client = client;
    this.knownPrompts = knownPrompts;
  }
  async latestSettledSeasonId(): Promise<number> {
    let id = (await this.client.getConfig()).current_season_id;
    while (id > 0) {
      const s = await this.client.getSeason(id);
      if (s?.status === 'settled') return id;
      id--;
    }
    throw new Error('no settled season');
  }
  private async paged<T>(f: (from: number, limit: number) => Promise<T[]>): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += 200) {
      const page = await f(from, 200);
      out.push(...page);
      if (page.length < 200) return out;
    }
  }
  async loadSeason(seasonId: number): Promise<SeasonData> {
    const season = await this.client.getSeason(seasonId);
    if (!season) throw new Error(`season ${seasonId} not found`);
    return {
      season,
      entries: await this.paged((f, l) => this.client.getEntries(seasonId, f, l)),
      matches: await this.paged((f, l) => this.client.getMatches(seasonId, f, l)),
      leaderboard: await this.client.getLeaderboard(seasonId),
      prompts: new Map(this.knownPrompts),
    };
  }
}
