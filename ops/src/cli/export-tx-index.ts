#!/usr/bin/env node
// Keeper journals (ops/runs/<season>.jsonl) → the web's NEXT_PUBLIC_INDEX_URL file. Read-only, no network.
//
//   pnpm --filter @osd/ops export-tx-index [--runs-dir ops/runs] [--out ops/runs/tx-index.json]
//
// Output: {"version":1,"tx":{"<season_id>:<a>:<b>":"<play_match tx hash>"}}

import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildTxIndex } from '../evidence.ts';
import { readJsonl } from '../txlog.ts';
import { die, RUNS_DIR } from './common.ts';

function main(): void {
  const { values: v } = parseArgs({ options: { 'runs-dir': { type: 'string', default: RUNS_DIR }, out: { type: 'string' } } });
  const dir = v['runs-dir']!;
  if (!existsSync(dir)) die(`no runs dir ${dir}`);
  // Top-level journals only: dryrun/ and mock/ subdirectories never hold real sends.
  const files = readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort();
  const idx = buildTxIndex(files.flatMap((f) => readJsonl(join(dir, f))));
  const text = JSON.stringify(idx, null, 2) + '\n';
  if (v.out) {
    writeFileSync(v.out, text);
    console.error(`wrote ${v.out} (${Object.keys(idx.tx).length} matches from ${files.length} journal(s))`);
  } else process.stdout.write(text);
}

main();
