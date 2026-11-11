import type { AttackResult, Evidence } from './results.ts';
import type { TxOutcome } from './near.ts';

export interface RunCtx {
  /** True in `run no-season`: never touch a live (non-settled) season. */
  noSeason?: boolean;
}

export interface Attack {
  /** Script name: `pnpm --filter @osd/attacks run <name>`. */
  name: string;
  attack: number;
  summary: string;
  /** `no-season`: needs no live season (runs against settled season 1 only); `season`: needs the attack season. */
  kind: 'no-season' | 'season' | 'both';
  run(ctx?: RunCtx): Promise<AttackResult[]>;
}

export function row(r: Omit<AttackResult, 'ts' | 'evidence'> & { evidence?: Evidence }): AttackResult {
  return { evidence: 'testnet', ...r, ts: new Date().toISOString() };
}

/** Short "actual" text for a tx outcome. */
export function actualOf(o: TxOutcome): string {
  if (!o.included) return `rejected before inclusion: ${o.error ?? '?'}`;
  if (!o.ok) return `refused: ${o.error ?? '?'}`;
  return `succeeded${o.value !== undefined ? ` → ${JSON.stringify(o.value).slice(0, 120)}` : ''}`;
}

/** True when the outcome is a refusal whose message matches. */
export function refusedWith(o: TxOutcome, re: RegExp): boolean {
  return !o.ok && re.test(o.error ?? '');
}

export function outlayerTouched(o: TxOutcome): boolean {
  return o.receipts.some((r) => r.executor === 'outlayer.testnet');
}
