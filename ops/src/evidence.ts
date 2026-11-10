// Evidence export: contract views (+ keeper run logs, optional tx receipts and
// NEP-297 events) → flat CSV/JSON for docs/EVIDENCE.md.

import type { TxStatus } from './rpc.ts';
import type { LogRecord } from './txlog.ts';
import type { Entry, LeaderboardRow, Match, Move, Season } from './types.ts';

export interface SeasonData {
  season: Season;
  entries: Entry[];
  matches: Match[];
  leaderboard: LeaderboardRow[];
  runlog?: LogRecord[];
  /** tx hash → status (EXPERIMENTAL_tx_status) for cost numbers. */
  txs?: Map<string, TxStatus>;
  events?: OsdEvent[];
}

export interface OsdEvent {
  standard: string;
  version: string;
  event: string;
  data: Record<string, unknown>[];
}

export function parseEventLines(text: string): OsdEvent[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('EVENT_JSON:'))
    .map((l) => JSON.parse(l.slice('EVENT_JSON:'.length)) as OsdEvent)
    .filter((e) => e.standard === 'osd');
}

export interface MatchRow {
  season_id: number;
  round: number;
  match_key: string;
  a: string;
  b: string;
  a_family: string;
  b_family: string;
  same_owner: boolean;
  status: string;
  a_move: string;
  b_move: string;
  outcome: string;
  a_payoff: number;
  b_payoff: number;
  pool_delta: number;
  sig_a_ok: boolean;
  sig_b_ok: boolean;
  void_reason: string;
  requested_at_block: number | '';
  settled_at_block: number | '';
  latency_blocks: number | '';
  play_tx: string;
}

export interface MoveRow {
  season_id: number;
  match_key: string;
  agent_id: string;
  family: string;
  owner: string;
  opponent_id: string;
  opponent_family: string;
  same_owner: boolean;
  move: Move;
  opponent_move: Move;
  payoff: number;
}

export interface FamilyRow {
  season_id: number;
  family: string;
  agents: number;
  moves: number;
  cooperate: number;
  defect: number;
  forfeit: number;
  coop_rate: number;
  avg_payoff: number;
  best_rank: number | '';
}

export interface SeasonSummary {
  season_id: number;
  status: string;
  agents: number;
  owners: number;
  matches: number;
  by_status: Record<string, number>;
  settled: number;
  void_total: number;
  void_reasons: Record<string, number>;
  moves: number;
  coop_rate: number;
  mutual_coop_rate: number;
  mutual_defect_rate: number;
  forfeit_moves: number;
  sig_ok_rate: number;
  pool_yocto: string;
  stake_per_agent_yocto: string | null;
  total_staked_yocto: string;
  latency_blocks: Stats | null;
  keeper_latency_s: Stats | null;
  cost: CostSummary | null;
  events: Record<string, number> | null;
  leaderboard_top: { rank: number | null; agent_id: string; family: string; avg_payoff_milli: number; prize_yocto: string }[];
}

export interface Stats {
  n: number;
  min: number;
  p50: number;
  p90: number;
  max: number;
  mean: number;
}

export interface CostSummary {
  txs: number;
  play_txs: number;
  gas_burnt_total: number;
  tokens_burnt_total_yocto: string;
  outlayer_charged_total_yocto: string;
  outlayer_runs: number;
  outlayer_time_ms: Stats | null;
  per_match_yocto: string | null;
}

export function stats(xs: number[]): Stats | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  return { n: s.length, min: s[0], p50: q(0.5), p90: q(0.9), max: s[s.length - 1], mean: round(s.reduce((a, b) => a + b, 0) / s.length, 3) };
}

function round(x: number, d: number): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

/** `"<season>:<a>:<b>"` → hash of the last successful play_match send (later re-sends win). */
export function playTxIndex(runlog: LogRecord[] = []): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of runlog) {
    if (r.kind === 'tx' && r.method === 'play_match' && r.outcome === 'ok' && r.tx_hash && r.args) {
      m.set(`${r.args.season_id}:${r.args.a}:${r.args.b}`, r.tx_hash);
    }
  }
  return m;
}

/** The web's NEXT_PUBLIC_INDEX_URL file (`export-tx-index`): match key → play_match tx hash, keys sorted. */
export interface TxIndexFile {
  version: 1;
  tx: Record<string, string>;
}

export function buildTxIndex(runlog: LogRecord[]): TxIndexFile {
  return { version: 1, tx: Object.fromEntries([...playTxIndex(runlog)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) };
}

export function matchRows(d: SeasonData): MatchRow[] {
  const ent = new Map(d.entries.map((e) => [e.agent_id, e]));
  const txs = playTxIndex(d.runlog);
  return d.matches.map((m) => {
    const ea = ent.get(m.a);
    const eb = ent.get(m.b);
    const lat = m.requested_at_block !== null && m.settled_at_block !== null ? m.settled_at_block - m.requested_at_block : '';
    return {
      season_id: m.season_id,
      round: m.round,
      match_key: m.match_key,
      a: m.a,
      b: m.b,
      a_family: ea?.family ?? '',
      b_family: eb?.family ?? '',
      same_owner: ea !== undefined && eb !== undefined && ea.owner === eb.owner,
      status: m.status,
      a_move: m.a_move ?? '',
      b_move: m.b_move ?? '',
      outcome: m.status === 'settled' && m.a_move && m.b_move ? m.a_move + m.b_move : '',
      a_payoff: m.a_payoff,
      b_payoff: m.b_payoff,
      pool_delta: m.pool_delta,
      sig_a_ok: m.sig_a_ok,
      sig_b_ok: m.sig_b_ok,
      void_reason: m.void_reason ?? '',
      requested_at_block: m.requested_at_block ?? '',
      settled_at_block: m.settled_at_block ?? '',
      latency_blocks: m.status === 'settled' ? lat : '',
      play_tx: txs.get(m.match_key) ?? '',
    };
  });
}

/** Two rows per settled match (one per side). */
export function moveRows(d: SeasonData): MoveRow[] {
  const ent = new Map(d.entries.map((e) => [e.agent_id, e]));
  const out: MoveRow[] = [];
  for (const m of d.matches) {
    if (m.status !== 'settled' || !m.a_move || !m.b_move) continue;
    const ea = ent.get(m.a);
    const eb = ent.get(m.b);
    const same = ea !== undefined && eb !== undefined && ea.owner === eb.owner;
    out.push({ season_id: m.season_id, match_key: m.match_key, agent_id: m.a, family: ea?.family ?? '', owner: ea?.owner ?? '', opponent_id: m.b, opponent_family: eb?.family ?? '', same_owner: same, move: m.a_move, opponent_move: m.b_move, payoff: m.a_payoff });
    out.push({ season_id: m.season_id, match_key: m.match_key, agent_id: m.b, family: eb?.family ?? '', owner: eb?.owner ?? '', opponent_id: m.a, opponent_family: ea?.family ?? '', same_owner: same, move: m.b_move, opponent_move: m.a_move, payoff: m.b_payoff });
  }
  return out;
}

export function familyRows(d: SeasonData): FamilyRow[] {
  const moves = moveRows(d);
  const fams = new Map<string, { agents: Set<string>; mv: MoveRow[] }>();
  for (const e of d.entries) {
    if (!fams.has(e.family)) fams.set(e.family, { agents: new Set(), mv: [] });
    fams.get(e.family)!.agents.add(e.agent_id);
  }
  for (const m of moves) fams.get(m.family)?.mv.push(m);
  const rank = new Map(d.leaderboard.map((r) => [r.agent_id, r.rank]));
  return [...fams.entries()]
    .map(([family, f]) => {
      const c = f.mv.filter((m) => m.move === 'C').length;
      const dd = f.mv.filter((m) => m.move === 'D').length;
      const ff = f.mv.filter((m) => m.move === 'F').length;
      const ranks = [...f.agents].map((a) => rank.get(a)).filter((r): r is number => typeof r === 'number');
      return {
        season_id: d.season.season_id,
        family,
        agents: f.agents.size,
        moves: f.mv.length,
        cooperate: c,
        defect: dd,
        forfeit: ff,
        coop_rate: f.mv.length ? round(c / f.mv.length, 4) : 0,
        avg_payoff: f.mv.length ? round(f.mv.reduce((a, m) => a + m.payoff, 0) / f.mv.length, 4) : 0,
        best_rank: ranks.length ? Math.min(...ranks) : ('' as const),
      };
    })
    .sort((x, y) => y.avg_payoff - x.avg_payoff || x.family.localeCompare(y.family));
}

const OUTLAYER_COMPLETED = /^EVENT_JSON:(\{"standard":"near-outlayer".*"event":"execution_completed".*\})$/;

export function costSummary(d: SeasonData): CostSummary | null {
  if (!d.txs || d.txs.size === 0) return null;
  const playHashes = new Set(playTxIndex(d.runlog).values());
  let gas = 0;
  let tokens = 0n;
  let charged = 0n;
  let runs = 0;
  const times: number[] = [];
  for (const st of d.txs.values()) {
    const outs = [st.transaction_outcome, ...(st.receipts_outcome ?? [])].filter((o) => o !== undefined);
    for (const o of outs) {
      gas += o.outcome.gas_burnt;
      tokens += BigInt(o.outcome.tokens_burnt);
      for (const log of o.outcome.logs) {
        const m = OUTLAYER_COMPLETED.exec(log);
        if (!m) continue;
        const ev = JSON.parse(m[1]) as { data: { payment_charged?: string; resources_used?: { time_ms?: number } }[] };
        for (const x of ev.data) {
          runs += 1;
          charged += BigInt(x.payment_charged ?? '0');
          if (typeof x.resources_used?.time_ms === 'number') times.push(x.resources_used.time_ms);
        }
      }
    }
  }
  const playN = [...d.txs.keys()].filter((h) => playHashes.has(h)).length;
  return {
    txs: d.txs.size,
    play_txs: playN,
    gas_burnt_total: gas,
    tokens_burnt_total_yocto: String(tokens),
    outlayer_charged_total_yocto: String(charged),
    outlayer_runs: runs,
    outlayer_time_ms: stats(times),
    per_match_yocto: playN ? String((tokens + charged) / BigInt(playN)) : null,
  };
}

/** Wall-clock seconds from the keeper's play_match send to the first view that showed the match final. */
function keeperLatency(runlog: LogRecord[] = []): number[] {
  const sent = new Map<string, number>();
  const out: number[] = [];
  for (const r of runlog) {
    if (r.kind === 'tx' && r.method === 'play_match' && r.outcome === 'ok' && r.args) sent.set(`${r.args.season_id}:${r.args.a}:${r.args.b}`, Date.parse(r.ts));
    if (r.kind === 'info' && r.msg === 'match_final' && r.status === 'settled' && typeof r.match_key === 'string' && sent.has(r.match_key)) {
      out.push(round((Date.parse(r.ts) - sent.get(r.match_key)!) / 1000, 3));
    }
  }
  return out;
}

export function seasonSummary(d: SeasonData): SeasonSummary {
  const moves = moveRows(d);
  const settled = d.matches.filter((m) => m.status === 'settled');
  const by: Record<string, number> = {};
  for (const m of d.matches) by[m.status] = (by[m.status] ?? 0) + 1;
  const reasons: Record<string, number> = {};
  for (const m of d.matches) if (m.void_reason) reasons[m.void_reason] = (reasons[m.void_reason] ?? 0) + 1;
  const outcome = (o: string) => (settled.length ? round(settled.filter((m) => (m.a_move ?? '') + (m.b_move ?? '') === o).length / settled.length, 4) : 0);
  const sigs = settled.flatMap((m) => [m.a_move === 'F' ? null : m.sig_a_ok, m.b_move === 'F' ? null : m.sig_b_ok]).filter((x) => x !== null);
  const stake = d.season.stake_per_agent_yocto;
  let events: Record<string, number> | null = null;
  if (d.events) {
    events = {};
    for (const e of d.events) {
      const sid = e.data[0]?.season_id;
      if (sid !== undefined && sid !== d.season.season_id) continue;
      events[e.event] = (events[e.event] ?? 0) + 1;
    }
  }
  return {
    season_id: d.season.season_id,
    status: d.season.status,
    agents: d.entries.length,
    owners: new Set(d.entries.map((e) => e.owner)).size,
    matches: d.matches.length,
    by_status: by,
    settled: settled.length,
    void_total: Object.values(reasons).reduce((a, b) => a + b, 0),
    void_reasons: reasons,
    moves: moves.length,
    coop_rate: moves.length ? round(moves.filter((m) => m.move === 'C').length / moves.length, 4) : 0,
    mutual_coop_rate: outcome('CC'),
    mutual_defect_rate: outcome('DD'),
    forfeit_moves: moves.filter((m) => m.move === 'F').length,
    sig_ok_rate: sigs.length ? round(sigs.filter(Boolean).length / sigs.length, 4) : 0,
    pool_yocto: d.season.pool_yocto,
    stake_per_agent_yocto: stake,
    total_staked_yocto: stake ? String(BigInt(stake) * BigInt(d.entries.length)) : '0',
    latency_blocks: stats(settled.filter((m) => m.requested_at_block !== null && m.settled_at_block !== null).map((m) => m.settled_at_block! - m.requested_at_block!)),
    keeper_latency_s: stats(keeperLatency(d.runlog)),
    cost: costSummary(d),
    events,
    leaderboard_top: d.leaderboard.slice(0, 10).map((r) => ({ rank: r.rank, agent_id: r.agent_id, family: r.family, avg_payoff_milli: r.avg_payoff_milli, prize_yocto: r.prize_yocto })),
  };
}

/** RFC 4180 CSV; header from the first row's keys (or `header`). */
export function toCsv<T extends object>(rows: T[], header?: string[]): string {
  const cols = header ?? (rows[0] ? Object.keys(rows[0]) : []);
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc((r as Record<string, unknown>)[c])).join(','))].join('\n') + '\n';
}
