// Strategy files: agents/strategies/<family>/<name>.md = frontmatter + prompt body.
// The PROMPT committed on chain is the body with leading/trailing whitespace trimmed (exact UTF-8 bytes).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, renderFrontmatter, type Frontmatter } from './frontmatter.ts';

/** INTERFACE.md §5: prompt ≤ 4000 bytes. */
export const PROMPT_MAX_BYTES = 4000;
/** INTERFACE.md §6.1 `commit` refuses family not matching this. */
export const FAMILY_RE = /^[a-z0-9_]{1,32}$/;
/** INTERFACE.md §1: agent name (sub-account label). Strategy name doubles as the house agent name. */
export const NAME_RE = /^[a-z0-9_-]{2,16}$/;
export const AUTHORS = ['house', 'evolver'] as const;

export const AGENTS_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const STRATEGIES_DIR = join(AGENTS_ROOT, 'strategies');
export const REPO_ROOT = join(AGENTS_ROOT, '..');

/** Contract-level lineage pointer (`parent` arg of `commit`). */
export interface Parent {
  season_id: number;
  agent_id: string;
}

export interface StrategyMeta {
  name: string;
  family: string;
  author: string;
  version: number;
  parent: Parent | null;
  description?: string;
  /** Local lineage: strategy file name of the parent (evolver offspring only). */
  parent_name?: string;
  generation?: number;
  mutation?: string;
  [k: string]: unknown;
}

export interface Strategy {
  meta: StrategyMeta;
  prompt: string;
  /** Absolute path of the file (empty for in-memory strategies). */
  path: string;
  raw: Frontmatter;
}

export const promptBytes = (p: string): number => Buffer.byteLength(p, 'utf8');

export function parseStrategy(text: string, path = ''): Strategy {
  const { data, body } = parseFrontmatter(text);
  return { meta: data as unknown as StrategyMeta, prompt: body.trim(), path, raw: data };
}

export function readStrategy(path: string): Strategy {
  return parseStrategy(readFileSync(path, 'utf8'), path);
}

export function renderStrategy(meta: StrategyMeta, prompt: string): string {
  return renderFrontmatter(meta as unknown as Frontmatter, prompt.trim() + '\n');
}

export function listStrategyFiles(dir: string = STRATEGIES_DIR): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.md')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function loadStrategies(dir: string = STRATEGIES_DIR): Strategy[] {
  return listStrategyFiles(dir).map(readStrategy);
}

export const rel = (p: string): string => relative(AGENTS_ROOT, p);
