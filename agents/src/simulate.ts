// Offline "local referee" simulator: round-robin over strategy files, two referee calls per pair.
// CLI: node --experimental-strip-types src/simulate.ts [--live] [--env <dotenv>] [--only a,b,c] [--max-calls N] [--json out.json]
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadNearAiEnv, MockLlm, NearAiClient, type LlmClient } from './llm.ts';
import { heuristicReply, loadRefereeTemplate, refereeMove, unpackRefereeRequest } from './referee.ts';
import { loadStrategies, type Strategy } from './strategy.ts';

export const PAYOFF: Record<string, [number, number]> = { CC: [3, 3], DC: [5, 1], CD: [1, 5], DD: [1, 1] };

export interface PairResult {
  a: string;
  b: string;
  a_move: 'C' | 'D';
  b_move: 'C' | 'D';
  a_payoff: number;
  b_payoff: number;
  a_reply: string;
  b_reply: string;
}

export interface SimReport {
  llm: string;
  pairs: PairResult[];
  agents: Array<{ name: string; family: string; matches: number; total: number; avg: number; coop_rate: number }>;
  families: Array<{ family: string; agents: number; avg: number }>;
  cooperation_rate: number;
  calls: number;
}

export function heuristicLlm(): MockLlm {
  return new MockLlm((req) => {
    const u = unpackRefereeRequest(req);
    return u ? heuristicReply(u.own, u.opponent) : 'D';
  });
}

export function roundRobin<T>(xs: T[]): Array<[T, T]> {
  const out: Array<[T, T]> = [];
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) out.push([xs[i], xs[j]]);
  return out;
}

export async function simulate(
  strategies: Strategy[],
  llm: LlmClient,
  opts: { template?: string; maxPairs?: number; pairs?: Array<[Strategy, Strategy]> } = {},
): Promise<SimReport> {
  const template = opts.template ?? loadRefereeTemplate();
  const pairs = (opts.pairs ?? roundRobin(strategies)).slice(0, opts.maxPairs ?? Infinity);
  const results: PairResult[] = [];
  let calls = 0;
  for (const [a, b] of pairs) {
    if (a.prompt === b.prompt) continue; // the TEE would void this as duplicate_prompt
    const ra = await refereeMove(llm, template, a.prompt, b.prompt);
    const rb = await refereeMove(llm, template, b.prompt, a.prompt);
    calls += 2;
    const [pa, pb] = PAYOFF[ra.move + rb.move];
    results.push({ a: a.meta.name, b: b.meta.name, a_move: ra.move, b_move: rb.move, a_payoff: pa, b_payoff: pb, a_reply: ra.reply, b_reply: rb.reply });
  }
  const byName = new Map(strategies.map((s) => [s.meta.name, s]));
  const stats = new Map<string, { total: number; matches: number; coop: number }>();
  const bump = (n: string, p: number, m: string): void => {
    const s = stats.get(n) ?? { total: 0, matches: 0, coop: 0 };
    s.total += p;
    s.matches++;
    if (m === 'C') s.coop++;
    stats.set(n, s);
  };
  for (const r of results) {
    bump(r.a, r.a_payoff, r.a_move);
    bump(r.b, r.b_payoff, r.b_move);
  }
  const agents = [...stats.entries()]
    .map(([name, s]) => ({ name, family: byName.get(name)!.meta.family, matches: s.matches, total: s.total, avg: s.total / s.matches, coop_rate: s.coop / s.matches }))
    .sort((x, y) => y.avg - x.avg || x.name.localeCompare(y.name));
  const fam = new Map<string, number[]>();
  for (const a of agents) fam.set(a.family, [...(fam.get(a.family) ?? []), a.avg]);
  const families = [...fam.entries()]
    .map(([family, v]) => ({ family, agents: v.length, avg: v.reduce((x, y) => x + y, 0) / v.length }))
    .sort((x, y) => y.avg - x.avg);
  const moves = results.flatMap((r) => [r.a_move, r.b_move]);
  return { llm: llm.label, pairs: results, agents, families, cooperation_rate: moves.filter((m) => m === 'C').length / (moves.length || 1), calls };
}

export function formatReport(r: SimReport): string {
  const lines = [`local referee (${r.llm}): ${r.pairs.length} pairs, ${r.calls} calls, cooperation ${(100 * r.cooperation_rate).toFixed(0)}%`, ''];
  for (const p of r.pairs) lines.push(`  ${p.a.padEnd(16)} ${p.a_move}${p.b_move} ${p.b.padEnd(16)} ${p.a_payoff}/${p.b_payoff}`);
  lines.push('', 'agents (avg payoff):');
  for (const a of r.agents) lines.push(`  ${a.name.padEnd(16)} ${a.family.padEnd(20)} ${a.avg.toFixed(2)}  coop ${(100 * a.coop_rate).toFixed(0)}%`);
  lines.push('', 'families:');
  for (const f of r.families) lines.push(`  ${f.family.padEnd(20)} ${f.avg.toFixed(2)} (${f.agents})`);
  return lines.join('\n');
}

if (process.argv[1]?.endsWith('simulate.ts')) {
  const { values } = parseArgs({
    options: {
      live: { type: 'boolean', default: false },
      env: { type: 'string' },
      only: { type: 'string' },
      'max-calls': { type: 'string', default: '10' },
      json: { type: 'string' },
    },
  });
  let strategies = loadStrategies();
  if (values.only) {
    const want = new Set(values.only.split(','));
    strategies = strategies.filter((s) => want.has(s.meta.name));
  }
  let llm: LlmClient = heuristicLlm();
  let maxPairs = Infinity;
  if (values.live) {
    if (values.env) loadNearAiEnv(values.env);
    llm = NearAiClient.fromEnv();
    maxPairs = Math.floor(Number(values['max-calls']) / 2);
  }
  const report = await simulate(strategies, llm, { maxPairs });
  console.log(formatReport(report));
  if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 2) + '\n');
}
