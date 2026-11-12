#!/usr/bin/env node
// Evidence exporter: contract views (or interfaces/fixtures) + keeper journals
// → CSV/JSON per season and across seasons. Read-only.
//
//   pnpm --filter @osd/ops export-evidence --fixtures            # from interfaces/fixtures
//   pnpm --filter @osd/ops export-evidence --season 1,2,3 [--fetch-tx [--tx-delay-ms 250]]  (tx statuses cached in ops/.state/txcache)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { familyRows, matchRows, moveRows, parseEventLines, seasonSummary, toCsv, type SeasonData } from '../evidence.ts';
import { fetchAll } from '../keeper.ts';
import { DEFAULT_RPC, NearRpc, type TxStatus } from '../rpc.ts';
import { readJsonl } from '../txlog.ts';
import type { Entry, LeaderboardRow, Match, Season } from '../types.ts';
import { DEFAULTS, die, FIXTURES_DIR, OPS_DIR, RUNS_DIR } from './common.ts';

async function main(): Promise<void> {
  const { values: v } = parseArgs({
    options: {
      fixtures: { type: 'boolean', default: false },
      'fixtures-dir': { type: 'string', default: FIXTURES_DIR },
      season: { type: 'string' },
      contract: { type: 'string', default: DEFAULTS.contract },
      network: { type: 'string', default: DEFAULTS.network },
      rpc: { type: 'string' },
      'runs-dir': { type: 'string' },
      events: { type: 'string' },
      'fetch-tx': { type: 'boolean', default: false },
      'tx-delay-ms': { type: 'string' },
      out: { type: 'string' },
    },
  });
  const runsDir = v['runs-dir'] ?? (v.contract === DEFAULTS.contract ? RUNS_DIR : join(RUNS_DIR, v.contract!));
  const out = v.out ?? join(RUNS_DIR, 'evidence', v.fixtures ? 'fixtures' : v.contract!);
  const rpc = new NearRpc(v.rpc ?? DEFAULT_RPC[v.network!] ?? die(`no default RPC for ${v.network}`));
  const data: SeasonData[] = [];

  if (v.fixtures) {
    const d = v['fixtures-dir']!;
    const j = <T>(f: string): T => JSON.parse(readFileSync(join(d, f), 'utf8')) as T;
    data.push({
      season: j<Season>('season.json'),
      entries: j<Entry[]>('entries.json'),
      matches: j<Match[]>('matches.json'),
      leaderboard: j<LeaderboardRow[]>('leaderboard.json'),
      events: parseEventLines(readFileSync(join(d, 'events.jsonl'), 'utf8')),
    });
  } else {
    if (!v.season) die('--season <n[,n...]> or --fixtures required');
    const chain = { view: <T>(m: string, a: Record<string, unknown>) => rpc.view<T>(v.contract!, m, a) };
    const events = v.events ? parseEventLines(readFileSync(v.events, 'utf8')) : undefined;
    for (const sid of v.season.split(',').map(Number)) {
      const season = await chain.view<Season | null>('get_season', { season_id: sid });
      if (!season) die(`season ${sid} not found on ${v.contract}`);
      const runlogPath = join(runsDir, `${sid}.jsonl`);
      const runlog = existsSync(runlogPath) ? readJsonl(runlogPath) : [];
      const sd: SeasonData = {
        season,
        entries: await fetchAll<Entry>(chain, 'get_entries', { season_id: sid }),
        matches: await fetchAll<Match>(chain, 'get_matches', { season_id: sid }),
        leaderboard: await chain.view<LeaderboardRow[]>('get_leaderboard', { season_id: sid }),
        runlog,
        events,
      };
      if (v['fetch-tx']) {
        sd.txs = new Map<string, TxStatus>();
        // Cache every final tx status on disk (a rerun after an RPC 429 refetches nothing) and pace the
        // lookups: a 300-match season is ~700 EXPERIMENTAL_tx_status calls, which trips the free RPC rate limit.
        const cacheDir = join(OPS_DIR, '.state', 'txcache');
        mkdirSync(cacheDir, { recursive: true });
        const delayMs = Number(v['tx-delay-ms'] ?? '0');
        for (const r of runlog) {
          if (r.kind !== 'tx' || r.outcome !== 'ok' || !r.tx_hash || typeof r.signer !== 'string') continue;
          const cf = join(cacheDir, `${r.tx_hash}.json`);
          if (existsSync(cf)) {
            sd.txs.set(r.tx_hash, JSON.parse(readFileSync(cf, 'utf8')) as TxStatus);
            continue;
          }
          const st = await rpc.txStatus(r.tx_hash, r.signer);
          writeFileSync(cf, JSON.stringify(st));
          sd.txs.set(r.tx_hash, st);
          if (delayMs > 0) await new Promise((res) => setTimeout(res, delayMs));
        }
      }
      data.push(sd);
    }
  }

  mkdirSync(out, { recursive: true });
  const summaries = [];
  for (const d of data) {
    const dir = join(out, `season-${d.season.season_id}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'matches.csv'), toCsv(matchRows(d)));
    writeFileSync(join(dir, 'moves.csv'), toCsv(moveRows(d)));
    writeFileSync(join(dir, 'families.csv'), toCsv(familyRows(d)));
    const s = seasonSummary(d);
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(s, null, 2) + '\n');
    summaries.push(s);
  }
  writeFileSync(join(out, 'seasons.csv'), toCsv(summaries.map((s) => ({ season_id: s.season_id, status: s.status, agents: s.agents, owners: s.owners, matches: s.matches, settled: s.settled, void: s.void_total, coop_rate: s.coop_rate, mutual_coop_rate: s.mutual_coop_rate, mutual_defect_rate: s.mutual_defect_rate, sig_ok_rate: s.sig_ok_rate, pool_yocto: s.pool_yocto, latency_p50_blocks: s.latency_blocks?.p50 ?? '', per_match_yocto: s.cost?.per_match_yocto ?? '' }))));
  writeFileSync(join(out, 'families.csv'), data.map((d) => toCsv(familyRows(d))).map((c, i) => (i === 0 ? c : c.split('\n').slice(1).join('\n'))).join(''));
  console.log(JSON.stringify(summaries, null, 2));
  console.error(`wrote ${out}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
