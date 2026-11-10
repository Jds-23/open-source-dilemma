// Minimal frontmatter codec for strategy files. Deliberately tiny (no YAML dependency):
// one `key: value` per line; values are null | true | false | integers | JSON ({…}, […], "…") | bare strings.

export type FmValue = string | number | boolean | null | { [k: string]: unknown } | unknown[];
export type Frontmatter = Record<string, FmValue>;

const FENCE = '---';

export function parseFrontmatter(text: string): { data: Frontmatter; body: string } {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!src.startsWith(FENCE + '\n')) throw new Error('missing opening --- frontmatter fence');
  const end = src.indexOf('\n' + FENCE + '\n', FENCE.length);
  if (end < 0) throw new Error('missing closing --- frontmatter fence');
  const head = src.slice(FENCE.length + 1, end);
  const body = src.slice(end + FENCE.length + 2);
  const data: Frontmatter = {};
  for (const [i, line] of head.split('\n').entries()) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const m = /^([a-z_][a-z0-9_]*):(?:\s(.*))?$/.exec(line);
    if (!m) throw new Error(`frontmatter line ${i + 1}: expected "key: value"`);
    if (m[1] in data) throw new Error(`frontmatter: duplicate key "${m[1]}"`);
    data[m[1]] = parseValue((m[2] ?? '').trim());
  }
  return { data, body };
}

function parseValue(v: string): FmValue {
  if (v === '' || v === 'null' || v === '~') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v.startsWith('{') || v.startsWith('[') || v.startsWith('"')) return JSON.parse(v) as FmValue;
  return v;
}

function renderValue(v: FmValue): string {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') {
    const bare = v !== '' && !/^[\s{["~#]|\s$|\n/.test(v) && !['null', 'true', 'false'].includes(v) && !/^-?\d+$/.test(v);
    return bare ? v : JSON.stringify(v);
  }
  return JSON.stringify(v);
}

export function renderFrontmatter(data: Frontmatter, body: string): string {
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${renderValue(v)}`);
  return `${FENCE}\n${lines.join('\n')}\n${FENCE}\n${body.endsWith('\n') ? body : body + '\n'}`;
}
