// Builds a MockChain from interfaces/fixtures so `keeper --mock` and the tests
// replay a realistic season (6 agents / 5 owners, 15 matches, 1 void).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { familyResolver, MockChain, type MockOptions, type Resolver } from './mock-chain.ts';
import type { Entry, Match, Season, SeasonParams } from './types.ts';

export interface Fixtures {
  season: Season;
  entries: Entry[];
  matches: Match[];
}

export function loadFixtures(dir: string): Fixtures {
  const j = <T>(f: string): T => JSON.parse(readFileSync(join(dir, f), 'utf8')) as T;
  return { season: j<Season>('season.json'), entries: j<Entry[]>('entries.json'), matches: j<Match[]>('matches.json') };
}

/** Replays the fixture outcome for a pair (moves or void reason); unknown pairs fall back to family defaults. */
export function fixtureResolver(matches: Match[]): Resolver {
  const by = new Map(matches.map((m) => [`${m.a}|${m.b}`, m]));
  return (m, ea, eb) => {
    const f = by.get(`${m.a}|${m.b}`);
    if (!f) return familyResolver(m, ea, eb);
    if (f.status === 'void' || (f.status === 'refunded' && f.void_reason)) return { kind: 'void', reason: f.void_reason ?? 'callback_failed' };
    if (f.a_move && f.b_move) return { kind: 'settled', a_move: f.a_move, b_move: f.b_move };
    return familyResolver(m, ea, eb);
  };
}

/** Season params with deadlines relative to the mock clock. */
export function mockParams(fx: Fixtures, nowNs: bigint, commitInS = 120, playInS = 6 * 3600): SeasonParams {
  return {
    ...fx.season.params,
    commit_deadline_ns: String(nowNs + BigInt(commitInS) * 1_000_000_000n),
    play_deadline_ns: String(nowNs + BigInt(playInS) * 1_000_000_000n),
  };
}

export function mockFromFixtures(dir: string, o: MockOptions = {}): { chain: MockChain; seasonId: number; fixtures: Fixtures } {
  const fx = loadFixtures(dir);
  const chain = new MockChain({ resolver: fixtureResolver(fx.matches), ...o });
  const seasonId = chain.seedSeason(
    mockParams(fx, chain.nowNs),
    fx.entries.map(({ season_id: _s, ...e }) => e),
  );
  return { chain, seasonId, fixtures: fx };
}
