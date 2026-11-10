// Page-level reads composed from the DataSource. Server-only (called from server components).
import { cooperationRate, verifyCommitment } from './game';
import { data, type DataSource } from './data';
import { agentName } from './links';
import type { Entry, LineageEntry, Match, Season } from './types';

export type PromptView =
  | { state: 'revealed'; prompt: string; salt: string }
  | { state: 'sealed' } // season not settled: prompts are only ever published after settlement
  | { state: 'unpublished' } // settled, owner has not published (or no index knows about it)
  | { state: 'mismatch' }; // a published text exists but does not hash to the on-chain commitment

export async function seasonIds(ds: DataSource = data()): Promise<number[]> {
  const cfg = await ds.getConfig();
  const n = cfg.current_season_id ?? 0;
  return Array.from({ length: n }, (_, i) => i + 1);
}

export async function allSeasons(ds: DataSource = data()): Promise<Season[]> {
  const ids = await seasonIds(ds);
  const seasons = await Promise.all(ids.map((id) => ds.getSeason(id)));
  return seasons.filter((s): s is Season => !!s);
}

export async function currentSeason(ds: DataSource = data()): Promise<Season | null> {
  const cfg = await ds.getConfig();
  return cfg.current_season_id ? ds.getSeason(cfg.current_season_id) : null;
}

export async function promptFor(season: Season, entry: Entry | undefined, ds: DataSource = data()): Promise<PromptView> {
  if (season.status !== 'settled') return { state: 'sealed' };
  if (!entry) return { state: 'unpublished' };
  const p = await ds.getPublishedPrompt(season.season_id, entry.agent_id);
  if (!p) return { state: 'unpublished' };
  const ok = await verifyCommitment(p.prompt, p.salt, entry.agent_id, entry.commitment);
  return ok ? { state: 'revealed', prompt: p.prompt, salt: p.salt } : { state: 'mismatch' };
}

export interface FeedItem {
  match: Match;
  aName: string;
  bName: string;
  aFamily: string;
  bFamily: string;
}

/** Most recent first: pending, then settled/void by settled block, newest season first. */
export async function recentFeed(limit = 12, ds: DataSource = data()): Promise<FeedItem[]> {
  const ids = (await seasonIds(ds)).reverse().slice(0, 2);
  const items: FeedItem[] = [];
  for (const id of ids) {
    const [matches, entries] = await Promise.all([ds.getMatches(id), ds.getEntries(id)]);
    const fam = new Map(entries.map((e) => [e.agent_id, e.family]));
    const played = matches
      .filter((m) => m.status !== 'scheduled')
      .sort((x, y) => (y.settled_at_block ?? Number.MAX_SAFE_INTEGER) - (x.settled_at_block ?? Number.MAX_SAFE_INTEGER));
    for (const m of played) {
      items.push({
        match: m,
        aName: agentName(m.a, ds.contractId),
        bName: agentName(m.b, ds.contractId),
        aFamily: fam.get(m.a) ?? '?',
        bFamily: fam.get(m.b) ?? '?',
      });
    }
  }
  return items.slice(0, limit);
}

export interface PopulationPoint {
  season_id: number;
  status: Season['status'];
  total: number;
  families: Record<string, number>;
  coopRate: number | null;
  /** best avg payoff per family (ranked agents only), milli-units */
  bestAvg: Record<string, number>;
}

export async function population(ds: DataSource = data()): Promise<PopulationPoint[]> {
  const seasons = await allSeasons(ds);
  return Promise.all(
    seasons.map(async (s) => {
      const [entries, matches, board] = await Promise.all([
        ds.getEntries(s.season_id),
        ds.getMatches(s.season_id),
        ds.getLeaderboard(s.season_id),
      ]);
      const families: Record<string, number> = {};
      for (const e of entries) families[e.family] = (families[e.family] ?? 0) + 1;
      const bestAvg: Record<string, number> = {};
      for (const r of board) if (r.rank !== null) bestAvg[r.family] = Math.max(bestAvg[r.family] ?? 0, r.avg_payoff_milli);
      return { season_id: s.season_id, status: s.status, total: entries.length, families, coopRate: cooperationRate(matches), bestAvg };
    }),
  );
}

export interface LineageNode {
  entry: LineageEntry;
  name: string;
  children: LineageNode[];
}

/**
 * Lineage around one agent: walk `parent` links up to the root (via get_lineage of each ancestor), then
 * collect every entry in any season whose parent points into this agent's line.
 */
export async function lineageTree(agentId: string, ds: DataSource = data()): Promise<{ root: LineageNode | null; self: LineageEntry[] }> {
  const self = await ds.getLineage(agentId);
  if (!self.length) return { root: null, self };

  const ids = await seasonIds(ds);
  const all: LineageEntry[] = [];
  for (const id of ids) {
    const [entries, board] = await Promise.all([ds.getEntries(id), ds.getLeaderboard(id)]);
    const rank = new Map(board.map((r) => [r.agent_id, r]));
    for (const e of entries) {
      const r = rank.get(e.agent_id);
      all.push({ season_id: id, agent_id: e.agent_id, commitment: e.commitment, family: e.family, parent: e.parent, rank: r?.rank ?? null, avg_payoff_milli: r?.avg_payoff_milli ?? 0 });
    }
  }
  const key = (s: number, a: string) => `${s}|${a}`;
  const byKey = new Map(all.map((l) => [key(l.season_id, l.agent_id), l]));

  // Root: earliest ancestor reachable from this agent's first entry.
  let rootEntry = self.reduce((x, y) => (x.season_id <= y.season_id ? x : y));
  const seen = new Set<string>();
  while (rootEntry.parent && !seen.has(key(rootEntry.season_id, rootEntry.agent_id))) {
    seen.add(key(rootEntry.season_id, rootEntry.agent_id));
    const p = byKey.get(key(rootEntry.parent.season_id, rootEntry.parent.agent_id));
    if (!p) break;
    rootEntry = p;
  }

  // Children = explicit parent links, plus the same agent re-entering in a later season without a parent.
  const childrenOf = (l: LineageEntry) =>
    all.filter(
      (c) =>
        (c.parent && c.parent.season_id === l.season_id && c.parent.agent_id === l.agent_id) ||
        (!c.parent && c.agent_id === l.agent_id && c.season_id === nextSeasonOf(l)),
    );
  const nextSeasonOf = (l: LineageEntry) => {
    const later = all.filter((x) => x.agent_id === l.agent_id && x.season_id > l.season_id).map((x) => x.season_id);
    return later.length ? Math.min(...later) : -1;
  };
  const visited = new Set<string>();
  const build = (l: LineageEntry, depth: number): LineageNode => {
    visited.add(key(l.season_id, l.agent_id));
    const kids = depth > 12 ? [] : childrenOf(l).filter((c) => !visited.has(key(c.season_id, c.agent_id)));
    return { entry: l, name: agentName(l.agent_id, ds.contractId), children: kids.map((c) => build(c, depth + 1)) };
  };
  return { root: build(rootEntry, 0), self };
}

export interface MatchDetail {
  season: Season;
  match: Match;
  a: { entry?: Entry; name: string; prompt: PromptView };
  b: { entry?: Entry; name: string; prompt: PromptView };
  tx: string | null;
}

export async function matchDetail(seasonId: number, aName: string, bName: string, ds: DataSource = data()): Promise<MatchDetail | null> {
  const season = await ds.getSeason(seasonId);
  if (!season) return null;
  const [matches, entries] = await Promise.all([ds.getMatches(seasonId), ds.getEntries(seasonId)]);
  const ids = [`${aName}.${ds.contractId}`, `${bName}.${ds.contractId}`].sort();
  const match = matches.find((m) => m.a === ids[0] && m.b === ids[1]);
  if (!match) return null;
  const ea = entries.find((e) => e.agent_id === match.a);
  const eb = entries.find((e) => e.agent_id === match.b);
  const [pa, pb, tx] = await Promise.all([promptFor(season, ea, ds), promptFor(season, eb, ds), ds.getMatchTx(match.match_key)]);
  return {
    season,
    match,
    a: { entry: ea, name: agentName(match.a, ds.contractId), prompt: pa },
    b: { entry: eb, name: agentName(match.b, ds.contractId), prompt: pb },
    tx,
  };
}

export async function allMatchParams(ds: DataSource = data()) {
  const out: Array<{ season: string; a: string; b: string }> = [];
  for (const id of await seasonIds(ds)) {
    for (const m of await ds.getMatches(id)) {
      out.push({ season: String(id), a: agentName(m.a, ds.contractId), b: agentName(m.b, ds.contractId) });
    }
  }
  return out;
}

export async function allAgentNames(ds: DataSource = data()) {
  const names = new Set<string>();
  for (const id of await seasonIds(ds)) for (const e of await ds.getEntries(id)) names.add(agentName(e.agent_id, ds.contractId));
  return [...names];
}
