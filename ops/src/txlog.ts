import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One JSON object per line in ops/runs/<season>.jsonl. Never contains secrets. */
export interface LogInput {
  kind: 'tx' | 'phase' | 'info' | 'warn' | 'error';
  season_id?: number | null;
  method?: string;
  args?: Record<string, unknown>;
  tx_hash?: string;
  outcome?: 'ok' | 'refused' | 'error' | 'skipped' | 'dry_run';
  attempt?: number;
  block?: number;
  error?: string;
  msg?: string;
  [k: string]: unknown;
}

export type LogRecord = LogInput & { ts: string };

export interface TxLog {
  write(rec: LogInput): void;
  records(): LogRecord[];
}

export class MemoryTxLog implements TxLog {
  private readonly recs: LogRecord[] = [];
  private readonly now: () => Date;
  constructor(now: () => Date = () => new Date(), initial: LogRecord[] = []) {
    this.now = now;
    this.recs.push(...initial);
  }
  write(rec: LogInput): void {
    this.recs.push({ ts: this.now().toISOString(), ...rec });
  }
  records(): LogRecord[] {
    return this.recs;
  }
}

export function readJsonl(path: string): LogRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as LogRecord);
}

/**
 * Routes records by season: `<dir>/<season_id>.jsonl`, or `<dir>/keeper.jsonl`
 * when no season is known yet (before open_season lands). All existing files
 * in `dir` are loaded, so a re-run sees everything earlier runs sent.
 */
export class SeasonRoutedLog implements TxLog {
  readonly dir: string;
  private readonly echo: boolean;
  private readonly now: () => Date;
  private readonly recs: LogRecord[] = [];

  constructor(dir: string, opts: { echo?: boolean; now?: () => Date } = {}) {
    this.dir = dir;
    this.echo = opts.echo ?? true;
    this.now = opts.now ?? (() => new Date());
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) this.recs.push(...readJsonl(join(dir, f)));
  }

  pathFor(seasonId: number | null | undefined): string {
    return join(this.dir, seasonId === null || seasonId === undefined ? 'keeper.jsonl' : `${seasonId}.jsonl`);
  }

  write(rec: LogInput): void {
    const full: LogRecord = { ts: this.now().toISOString(), ...rec };
    this.recs.push(full);
    const line = JSON.stringify(full);
    appendFileSync(this.pathFor(full.season_id), line + '\n');
    if (this.echo) console.log(line);
  }

  records(): LogRecord[] {
    return this.recs;
  }
}
