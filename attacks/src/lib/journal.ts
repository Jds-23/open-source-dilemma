// Read the keeper journal of the attack season (attacks/runs/<season>.jsonl) for play/refund tx hashes.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_DIR } from './season.ts';

export interface JournalTx {
  kind: string;
  method?: string;
  args?: { season_id?: number; a?: string; b?: string };
  tx_hash?: string;
  outcome?: string;
}

export function journal(seasonId: number): JournalTx[] {
  const f = join(RUNS_DIR, `${seasonId}.jsonl`);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as JournalTx);
}

/** Last ok tx of `method` for the pair (either order). */
export function txFor(seasonId: number, method: string, x: string, y: string): string | undefined {
  const hits = journal(seasonId).filter(
    (r) => r.kind === 'tx' && r.method === method && r.outcome === 'ok' && r.tx_hash && ((r.args?.a === x && r.args?.b === y) || (r.args?.a === y && r.args?.b === x)),
  );
  return hits.at(-1)?.tx_hash;
}
