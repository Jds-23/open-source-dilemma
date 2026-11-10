// Prompt linter: frontmatter shape, family tag, name, length cap, duplicates, and no secrets.
// CLI: node --experimental-strip-types src/lint.ts [dir...]   (exit 1 on any error)
import { basename, dirname } from 'node:path';
import {
  AUTHORS, FAMILY_RE, NAME_RE, PROMPT_MAX_BYTES, STRATEGIES_DIR,
  listStrategyFiles, parseStrategy, promptBytes, rel, type Strategy,
} from './strategy.ts';
import { readFileSync } from 'node:fs';

export interface LintIssue {
  file: string;
  message: string;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/, 'looks like an ed25519 secret key'],
  [/secp256k1:[1-9A-HJ-NP-Za-km-z]{60,}/, 'looks like a secp256k1 secret key'],
  [/(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/, 'contains a 32-byte hex string (seed/key/salt?)'],
  [/\bsk-[A-Za-z0-9_-]{16,}/, 'looks like an API key (sk-…)'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'contains a PEM private key'],
  [/\b(NEARAI_API_KEY|PROTECTED_SEASON_SEED)\b/, 'mentions a secret env var name'],
  [/\b(api[_-]?key|secret[_-]?key|private[_-]?key|seed[_-]?phrase)\s*[:=]/i, 'contains a key assignment'],
  [/^\s*(?:[a-z]{3,8}[ \t]+){11}[a-z]{3,8}\s*$/m, 'looks like a 12-word seed phrase'],
];

/** Values of secret env vars currently loaded: a prompt must never contain them. */
function liveSecrets(): string[] {
  return ['NEARAI_API_KEY', 'PROTECTED_SEASON_SEED']
    .map((k) => process.env[k])
    .filter((v): v is string => typeof v === 'string' && v.length >= 8);
}

export function scanSecrets(text: string): string[] {
  const hits = SECRET_PATTERNS.filter(([re]) => re.test(text)).map(([, m]) => m);
  if (liveSecrets().some((s) => text.includes(s))) hits.push('contains the value of a loaded secret env var');
  return hits;
}

const isParent = (p: unknown): boolean =>
  p === null ||
  (typeof p === 'object' && p !== null && !Array.isArray(p) &&
    Number.isInteger((p as Record<string, unknown>).season_id) &&
    ((p as Record<string, unknown>).season_id as number) >= 0 &&
    typeof (p as Record<string, unknown>).agent_id === 'string' &&
    ((p as Record<string, unknown>).agent_id as string).length > 0);

/** Lint one parsed strategy. `file` (if given) also checks name == file stem and family == parent dir. */
export function lintStrategy(s: Strategy, fileText?: string): string[] {
  const errs: string[] = [];
  const m = s.meta;
  for (const k of ['name', 'family', 'author', 'version', 'parent']) {
    if (!(k in s.raw)) errs.push(`frontmatter: missing "${k}"`);
  }
  if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) errs.push(`name must match ${NAME_RE}`);
  if (typeof m.family !== 'string' || !FAMILY_RE.test(m.family)) errs.push(`family tag must match ${FAMILY_RE}`);
  if (!AUTHORS.includes(m.author as (typeof AUTHORS)[number])) errs.push(`author must be one of ${AUTHORS.join('|')}`);
  if (!Number.isInteger(m.version) || m.version < 1) errs.push('version must be a positive integer');
  if (!isParent(m.parent)) errs.push('parent must be null or {"season_id": u32, "agent_id": string}');
  if (m.author === 'house' && m.parent !== null && m.version === 1) errs.push('house seed (version 1) must have parent: null');
  if (m.author === 'evolver' && (m.parent === null || typeof m.parent_name !== 'string')) {
    errs.push('evolver offspring need parent and parent_name');
  }
  if (s.path) {
    if (typeof m.name === 'string' && basename(s.path, '.md') !== m.name) errs.push(`name "${m.name}" != file name`);
    if (typeof m.family === 'string' && basename(dirname(s.path)) !== m.family) errs.push(`family "${m.family}" != directory`);
  }
  const bytes = promptBytes(s.prompt);
  if (bytes === 0) errs.push('empty prompt');
  if (bytes > PROMPT_MAX_BYTES) errs.push(`prompt is ${bytes} bytes > ${PROMPT_MAX_BYTES}`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s.prompt)) errs.push('prompt contains control characters');
  for (const hit of scanSecrets(fileText ?? s.prompt)) errs.push(`secret scan: ${hit}`);
  return errs;
}

/** Lint many strategies, plus cross-file checks (unique names, no byte-equal prompts → duplicate_prompt voids). */
export function lintStrategies(items: Array<{ s: Strategy; text?: string }>): LintIssue[] {
  const issues: LintIssue[] = [];
  const names = new Map<string, string>();
  const prompts = new Map<string, string>();
  for (const { s, text } of items) {
    const file = s.path ? rel(s.path) : String(s.meta.name);
    for (const message of lintStrategy(s, text)) issues.push({ file, message });
    const n = String(s.meta.name);
    if (names.has(n)) issues.push({ file, message: `duplicate name (also ${names.get(n)})` });
    else names.set(n, file);
    if (prompts.has(s.prompt)) issues.push({ file, message: `byte-identical prompt to ${prompts.get(s.prompt)} (would be voided as duplicate_prompt)` });
    else prompts.set(s.prompt, file);
  }
  return issues;
}

export function lintDir(dir: string = STRATEGIES_DIR): { files: number; issues: LintIssue[] } {
  const items: Array<{ s: Strategy; text?: string }> = [];
  const issues: LintIssue[] = [];
  const files = listStrategyFiles(dir);
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    try {
      items.push({ s: parseStrategy(text, f), text });
    } catch (e) {
      issues.push({ file: rel(f), message: (e as Error).message });
    }
  }
  return { files: files.length, issues: [...issues, ...lintStrategies(items)] };
}

if (import.meta.main ?? process.argv[1]?.endsWith('lint.ts')) {
  const dirs = process.argv.slice(2);
  let bad = 0;
  let total = 0;
  for (const d of dirs.length ? dirs : [STRATEGIES_DIR]) {
    const { files, issues } = lintDir(d);
    total += files;
    for (const i of issues) console.error(`${i.file}: ${i.message}`);
    bad += issues.length;
  }
  console.log(`prompt lint: ${total} files, ${bad} issue(s)`);
  process.exit(bad ? 1 : 0);
}
