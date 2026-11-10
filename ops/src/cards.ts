// WS-8 strategy cards: turn the core contract's views for a settled season into
// `mint_season_cards` rows for the cards contract (contracts/cards). Pure; the CLI
// (src/cli/mint-cards.ts) does the I/O.
//
// family: the house plan (agents/plans/season-<n>[.seed].json, built from the strategy
// files' frontmatter) wins when it lists the agent; else the family the entry declared at
// commit; else "unknown".

import type { Parent } from './types.ts';

export interface LeaderboardRowView {
  agent_id: string;
  owner: string;
  family: string;
  avg_payoff_milli: number;
  rank: number | null;
}

export interface EntryView {
  agent_id: string;
  owner: string;
  family: string;
  parent: Parent | null;
  commitment: string;
}

export interface CardRow {
  agent_id: string;
  owner: string;
  family: string;
  rank: number | null;
  avg_payoff_milli: number | null;
  commitment: string;
  parent: Parent | null;
}

export const MINT_BATCH = 20;
const FAMILY_RE = /^[a-z0-9_]{1,32}$/;

export const cardTokenId = (seasonId: number, agentId: string): string => `s${seasonId}:${agentId}`;
export const badgeTokenId = (seasonId: number): string => `badge:s${seasonId}`;

export function resolveFamily(agentId: string, entryFamily: string, planFamilies: Map<string, string>): string {
  for (const f of [planFamilies.get(agentId), entryFamily]) if (f && FAMILY_RE.test(f)) return f;
  return 'unknown';
}

/** One row per entry, in leaderboard (rank) order; entries missing from the leaderboard follow. */
export function buildCardRows(
  leaderboard: LeaderboardRowView[],
  entries: EntryView[],
  planFamilies: Map<string, string> = new Map(),
): CardRow[] {
  const lb = new Map(leaderboard.map((r) => [r.agent_id, r]));
  const order = [...leaderboard.map((r) => r.agent_id), ...entries.map((e) => e.agent_id).filter((id) => !lb.has(id))];
  const byId = new Map(entries.map((e) => [e.agent_id, e]));
  return order.map((id) => {
    const e = byId.get(id);
    if (!e) throw new Error(`leaderboard agent ${id} has no entry`);
    const r = lb.get(id);
    return {
      agent_id: id,
      owner: e.owner,
      family: resolveFamily(id, e.family, planFamilies),
      rank: r?.rank ?? null,
      avg_payoff_milli: r ? r.avg_payoff_milli : null,
      commitment: e.commitment,
      parent: e.parent,
    };
  });
}

export function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** `settle_season` tx hash (last successful one) from a keeper journal. */
export function settleTxFrom(records: { kind?: string; method?: string; outcome?: string; tx_hash?: string; season_id?: number | null }[], seasonId: number): string | null {
  let tx: string | null = null;
  for (const r of records) {
    if (r.kind === 'tx' && r.method === 'settle_season' && r.outcome === 'ok' && r.season_id === seasonId && r.tx_hash) tx = r.tx_hash;
  }
  return tx;
}
