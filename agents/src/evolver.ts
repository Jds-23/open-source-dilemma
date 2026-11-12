// Evolver agent: read last season → rank families → LLM-mutate top & bottom prompts →
// write offspring strategy files (with lineage) → emit a commit plan (agent id → prompt file) for the keeper.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { LeaderboardRow, SeasonData, SeasonSource } from './adapter.ts';
import { lintStrategy } from './lint.ts';
import type { LlmClient } from './llm.ts';
import {
  NAME_RE, PROMPT_MAX_BYTES, REPO_ROOT, STRATEGIES_DIR,
  loadStrategies, promptBytes, renderStrategy, type Parent, type Strategy, type StrategyMeta,
} from './strategy.ts';

export const DEFAULT_CONTRACT = 'osd.baldingsucks7993.testnet';
export type Mutation = 'exploit' | 'repair';

export interface FamilyStat {
  family: string;
  agents: number;
  avg_payoff_milli: number;
  best_rank: number | null;
  coop_rate: number;
}

export interface Offspring {
  name: string;
  agent_id: string;
  family: string;
  parent: Parent;
  parent_name: string;
  mutation: Mutation;
  version: number;
  prompt: string;
  file: string;
}

export interface PlanEntry {
  agent_id: string;
  name: string;
  family: string;
  parent: Parent | null;
  /** Repo-relative path of the strategy file; the keeper seals `loadStrategy(file).prompt`. */
  prompt_file: string;
  prompt_bytes: number;
  role: 'seed' | 'survivor' | 'offspring';
}

export interface CommitPlan {
  plan_version: 1;
  /** Season the entries are meant for (last settled + 1, or 1 for a seed plan). */
  season_id: number;
  contract: string;
  from_season: number | null;
  source: string;
  llm: string | null;
  family_ranking: FamilyStat[];
  entries: PlanEntry[];
  culled: string[];
  skipped: Array<{ agent_id: string; reason: string }>;
}

export interface EvolveOptions {
  source: SeasonSource;
  llm: LlmClient;
  /** Directory offspring are written to (as <outDir>/<family>/<name>.md). */
  outDir?: string;
  /** House strategies used to resolve prompts of house agents and to avoid name/prompt clashes. */
  houseDir?: string;
  contract?: string;
  seasonId?: number;
  topK?: number;
  bottomK?: number;
  /** Write files (default true). With false, offspring are returned but nothing touches disk. */
  write?: boolean;
  maxAgents?: number;
  /** Season the offspring are for (default: evolved season + 1; later if other seasons ran in between). */
  nextSeasonId?: number;
  log?: (msg: string) => void;
}

export interface EvolveResult {
  plan: CommitPlan;
  offspring: Offspring[];
}

const nameOf = (agentId: string): string => agentId.split('.')[0];
const repoRel = (p: string): string => relative(REPO_ROOT, p).split('\\').join('/');

export function rankFamilies(data: SeasonData): FamilyStat[] {
  const rows = data.leaderboard.filter((r) => r.rank !== null && r.matches_counted > 0);
  const famOf = new Map(data.entries.map((e) => [e.agent_id, e.family]));
  const coop = new Map<string, { c: number; n: number }>();
  for (const m of data.matches) {
    if (m.status !== 'settled') continue;
    for (const [id, mv] of [[m.a, m.a_move], [m.b, m.b_move]] as const) {
      const f = famOf.get(id);
      if (!f || !mv) continue;
      const s = coop.get(f) ?? { c: 0, n: 0 };
      s.n++;
      if (mv === 'C') s.c++;
      coop.set(f, s);
    }
  }
  const by = new Map<string, LeaderboardRow[]>();
  for (const r of rows) by.set(r.family, [...(by.get(r.family) ?? []), r]);
  return [...by.entries()]
    .map(([family, rs]) => ({
      family,
      agents: rs.length,
      avg_payoff_milli: Math.floor(rs.reduce((s, r) => s + r.avg_payoff_milli, 0) / rs.length),
      best_rank: Math.min(...rs.map((r) => r.rank as number)),
      coop_rate: coop.get(family) ? coop.get(family)!.c / coop.get(family)!.n : 0,
    }))
    .sort((a, b) => b.avg_payoff_milli - a.avg_payoff_milli || (a.best_rank ?? 1e9) - (b.best_rank ?? 1e9));
}

/** Offspring name: <stem>-s<season><letter>, ≤ 16 chars, unique against `taken`. */
export function offspringName(parentName: string, season: number, taken: Set<string>): string {
  const stem0 = parentName.replace(/-s\d+[a-z]$/, '').replace(/[^a-z0-9_-]/g, '');
  for (let i = 0; i < 26; i++) {
    const suffix = `-s${season}${String.fromCharCode(97 + i)}`;
    const name = stem0.slice(0, 16 - suffix.length).replace(/-+$/, '') + suffix;
    if (!taken.has(name) && NAME_RE.test(name)) return name;
  }
  throw new Error(`cannot derive a unique offspring name for ${parentName}`);
}

export function cleanLlmPrompt(reply: string): string {
  let t = reply.trim();
  t = t.replace(/^<think>[\s\S]*?<\/think>\s*/i, '');
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(t);
  if (fence) t = fence[1];
  if (t.startsWith('---\n')) {
    const end = t.indexOf('\n---\n', 4);
    if (end > 0) t = t.slice(end + 5);
  }
  return t.trim();
}

const SYSTEM = `You design strategy prompts for "Open Source Dilemma", a ONE-SHOT prisoner's dilemma between strategy prompts.
In each match an LLM referee acting for a player reads that player's strategy (YOUR STRATEGY) and the opponent's full strategy text (OPPONENT STRATEGY) and replies with exactly one letter: C (cooperate) or D (defect).
Payoffs (you/opponent): C/C 3/3, D/C 5/1, C/D 1/5, D/D 1/1 (4 more go to a shared pool). A strategy that cannot be decrypted or verified forfeits.
The opponent's referee reads YOUR text as well, so your text influences their move: prompt injection is legal, and so is defending against it.
Write ONE new strategy prompt. Rules:
- Output only the strategy text: no preamble, no markdown fences, no frontmatter.
- At most ${PROMPT_MAX_BYTES} bytes (aim for under 1200). Plain text.
- Write it as instructions to the referee about which letter to choose, with a clear, decidable rule.
- It must differ from the parent text. Never include keys, secrets or URLs.
- If the parent contains a passphrase, token or membership mark, keep it byte-exact.`;

function summarise(data: SeasonData, fam: FamilyStat[]): string {
  const lines = ['Family ranking last season (avg payoff per counted match, milli-units; 3000 = mutual cooperation):'];
  for (const f of fam) lines.push(`- ${f.family}: avg ${f.avg_payoff_milli}, best rank ${f.best_rank}, cooperation ${(100 * f.coop_rate).toFixed(0)}%`);
  return lines.join('\n');
}

function recordOf(data: SeasonData, agentId: string): string {
  const fam = new Map(data.entries.map((e) => [e.agent_id, e.family]));
  const lines: string[] = [];
  for (const m of data.matches) {
    if (m.a !== agentId && m.b !== agentId) continue;
    const meA = m.a === agentId;
    const opp = meA ? m.b : m.a;
    if (m.status !== 'settled') {
      lines.push(`- vs ${fam.get(opp) ?? opp}: ${m.status}${m.void_reason ? ` (${m.void_reason})` : ''}`);
      continue;
    }
    const mine = meA ? m.a_move : m.b_move;
    const theirs = meA ? m.b_move : m.a_move;
    const pay = meA ? m.a_payoff : m.b_payoff;
    lines.push(`- vs ${fam.get(opp) ?? opp}: me ${mine}, them ${theirs}, payoff ${pay}`);
  }
  return lines.join('\n');
}

export function mutationRequest(mode: Mutation, parent: { row: LeaderboardRow; prompt: string }, data: SeasonData, fam: FamilyStat[], winners: string[]) {
  const task = mode === 'exploit'
    ? `This strategy finished near the TOP (rank ${parent.row.rank}). Keep its core idea and family identity "${parent.row.family}", but make it stronger: fix the matches where it scored below 3, resist manipulation by the opponent text, and avoid being exploited.`
    : `This strategy finished near the BOTTOM (rank ${parent.row.rank}). Diagnose why it lost and rewrite it so it scores better, keeping the family identity "${parent.row.family}". You may borrow ideas from the winning strategies shown below.`;
  const parts = [
    summarise(data, fam),
    '',
    `Parent strategy (family ${parent.row.family}, avg ${parent.row.avg_payoff_milli}):`,
    '<<<', parent.prompt, '>>>',
    '',
    'Its matches:',
    recordOf(data, parent.row.agent_id) || '- (none)',
  ];
  if (mode === 'repair' && winners.length) {
    parts.push('', 'Winning strategies last season:');
    for (const w of winners) parts.push('<<<', w, '>>>');
  }
  parts.push('', task, '', 'Reply with the new strategy text only.');
  return {
    messages: [
      { role: 'system' as const, content: SYSTEM },
      { role: 'user' as const, content: parts.join('\n') },
    ],
    temperature: 0.8,
    max_tokens: 1200,
    enable_thinking: false,
  };
}

/** Prompt resolution: published prompt first, then a local house file with the same name. */
function resolvePrompt(agentId: string, data: SeasonData, house: Map<string, Strategy>): { prompt: string; local?: Strategy } | null {
  const published = data.prompts.get(agentId);
  const local = house.get(nameOf(agentId));
  if (published !== undefined) return { prompt: published, local: local && local.prompt === published ? local : undefined };
  return local ? { prompt: local.prompt, local } : null;
}

export async function evolve(opts: EvolveOptions): Promise<EvolveResult> {
  const log = opts.log ?? (() => {});
  const contract = opts.contract ?? DEFAULT_CONTRACT;
  const outDir = opts.outDir ?? STRATEGIES_DIR;
  const write = opts.write ?? true;
  const topK = opts.topK ?? 3;
  const bottomK = opts.bottomK ?? 3;
  const seasonId = opts.seasonId ?? (await opts.source.latestSettledSeasonId());
  const data = await opts.source.loadSeason(seasonId);
  const next = opts.nextSeasonId ?? seasonId + 1;
  const houseList = existsSync(opts.houseDir ?? STRATEGIES_DIR) ? loadStrategies(opts.houseDir ?? STRATEGIES_DIR) : [];
  const outList = outDir !== (opts.houseDir ?? STRATEGIES_DIR) && existsSync(outDir) ? loadStrategies(outDir) : [];
  const house = new Map(houseList.map((s) => [s.meta.name, s]));
  const takenNames = new Set([...houseList, ...outList].map((s) => s.meta.name).concat(data.entries.map((e) => nameOf(e.agent_id))));
  const knownPrompts = new Set([...houseList, ...outList].map((s) => s.prompt).concat([...data.prompts.values()]));

  const fam = rankFamilies(data);
  log(`season ${seasonId} (${opts.source.label}): ${data.leaderboard.length} rows, ${fam.length} families`);

  const ranked = data.leaderboard.filter((r) => r.rank !== null).sort((a, b) => (a.rank as number) - (b.rank as number));
  const skipped: CommitPlan['skipped'] = [];
  const withPrompt = ranked.filter((r) => {
    if (resolvePrompt(r.agent_id, data, house)) return true;
    skipped.push({ agent_id: r.agent_id, reason: 'prompt unknown (not published, not a house file)' });
    return false;
  });
  const k = Math.min(topK, Math.floor(withPrompt.length / 2));
  const kb = Math.min(bottomK, withPrompt.length - k);
  const top = withPrompt.slice(0, k);
  const bottom = withPrompt.slice(withPrompt.length - kb);
  const winners = top.slice(0, 2).map((r) => resolvePrompt(r.agent_id, data, house)!.prompt);

  const offspring: Offspring[] = [];
  const jobs: Array<[Mutation, LeaderboardRow]> = [...top.map((r) => ['exploit', r] as [Mutation, LeaderboardRow]), ...bottom.map((r) => ['repair', r] as [Mutation, LeaderboardRow])];
  for (const [mode, row] of jobs) {
    const res = resolvePrompt(row.agent_id, data, house)!;
    const req = mutationRequest(mode, { row, prompt: res.prompt }, data, fam, winners);
    const name = offspringName(nameOf(row.agent_id), next, takenNames);
    const parent: Parent = { season_id: seasonId, agent_id: row.agent_id };
    const meta: StrategyMeta = {
      name,
      family: row.family,
      author: 'evolver',
      version: (res.local?.meta.version ?? 1) + 1,
      parent,
      parent_name: nameOf(row.agent_id),
      mutation: mode,
      description: `${mode} mutation of ${nameOf(row.agent_id)} (season ${seasonId} rank ${row.rank}, avg ${row.avg_payoff_milli})`,
    };
    let prompt = '';
    let lastErr = '';
    for (let attempt = 0; attempt < 2 && !prompt; attempt++) {
      const r = attempt === 0 ? req : { ...req, messages: [...req.messages, { role: 'user' as const, content: `Your previous answer was rejected: ${lastErr}. Try again.` }] };
      const cand = cleanLlmPrompt(await opts.llm.chat(r));
      const errs = lintStrategy({ meta, prompt: cand, path: '', raw: meta as never });
      if (knownPrompts.has(cand)) errs.push('identical to an existing prompt (would void as duplicate_prompt)');
      if (errs.length) lastErr = errs.join('; ');
      else prompt = cand;
    }
    if (!prompt) {
      skipped.push({ agent_id: row.agent_id, reason: `mutation rejected: ${lastErr}` });
      log(`skip ${row.agent_id}: ${lastErr}`);
      continue;
    }
    takenNames.add(name);
    knownPrompts.add(prompt);
    const file = join(outDir, row.family, `${name}.md`);
    if (write) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, renderStrategy(meta, prompt));
    }
    offspring.push({ name, agent_id: `${name}.${contract}`, family: row.family, parent, parent_name: meta.parent_name!, mutation: mode, version: meta.version, prompt, file });
    log(`${mode}: ${nameOf(row.agent_id)} → ${name} (${promptBytes(prompt)} B)`);
  }

  // Survivors: house agents that played last season, were not culled, and whose local file is what they played.
  const culled = new Set(bottom.map((r) => r.agent_id));
  const survivors: PlanEntry[] = [];
  for (const r of ranked) {
    if (culled.has(r.agent_id)) continue;
    const res = resolvePrompt(r.agent_id, data, house);
    if (!res?.local) continue;
    survivors.push({
      agent_id: r.agent_id, name: res.local.meta.name, family: res.local.meta.family,
      parent: { season_id: seasonId, agent_id: r.agent_id },
      prompt_file: repoRel(res.local.path), prompt_bytes: promptBytes(res.local.prompt), role: 'survivor',
    });
  }
  const kids: PlanEntry[] = offspring.map((o) => ({
    agent_id: o.agent_id, name: o.name, family: o.family, parent: o.parent,
    prompt_file: repoRel(o.file), prompt_bytes: promptBytes(o.prompt), role: 'offspring',
  }));
  const maxAgents = opts.maxAgents ?? data.season.params.max_agents ?? 40;
  const entries = [...kids, ...survivors].slice(0, maxAgents);

  return {
    offspring,
    plan: {
      plan_version: 1, season_id: next, contract, from_season: seasonId, source: opts.source.label, llm: opts.llm.label,
      family_ranking: fam, entries, culled: [...culled], skipped,
    },
  };
}

/** Bootstrap plan: every house seed strategy as its own agent (`<name>.<contract>`). */
export function seedPlan(dir: string = STRATEGIES_DIR, contract: string = DEFAULT_CONTRACT, seasonId = 1): CommitPlan {
  const entries: PlanEntry[] = loadStrategies(dir)
    .filter((s) => s.meta.author === 'house')
    .map((s) => ({
      agent_id: `${s.meta.name}.${contract}`, name: s.meta.name, family: s.meta.family, parent: s.meta.parent ?? null,
      prompt_file: repoRel(s.path), prompt_bytes: promptBytes(s.prompt), role: 'seed',
    }));
  return { plan_version: 1, season_id: seasonId, contract, from_season: null, source: repoRel(dir), llm: null, family_ranking: [], entries, culled: [], skipped: [] };
}

export function writePlan(plan: CommitPlan, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(plan, null, 2) + '\n');
}
