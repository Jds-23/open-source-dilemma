// The keeper talks to the contract only through this interface, so the same
// logic runs against testnet (NearChain), a read-only planner (DryRunChain)
// and an in-memory contract (MockChain, tests + `--mock`).

import { DEFAULT_GAS } from '@osd/sdk';

/** Recommended gas per method (WS-1 measurements, shared with @osd/sdk `DEFAULT_GAS`); 300 Tgas for unknown methods. */
export function gasFor(method: string): bigint {
  return (DEFAULT_GAS as Record<string, bigint>)[method] ?? 300_000_000_000_000n;
}

export interface CallOptions {
  depositYocto?: bigint;
  gas?: bigint;
}

export interface TxResult {
  txHash: string;
  /** Block height seen when the tx was sent (for grace windows). */
  block: number;
  /** JSON-decoded return value when known (e.g. settle_season's ranking or `[]`). */
  value?: unknown;
}

export interface Chain {
  readonly contractId: string;
  readonly signerId: string;
  view<T>(method: string, args: Record<string, unknown>): Promise<T>;
  call(method: string, args: Record<string, unknown>, opts?: CallOptions): Promise<TxResult>;
  /** Latest final block height and timestamp (ns). */
  head(): Promise<{ height: number; timestampNs: bigint }>;
  sleep(ms: number): Promise<void>;
}

export type ChainErrorKind = 'transient' | 'refused';

/** `refused` = the contract (or protocol) said no; never retried. */
export class ChainError extends Error {
  readonly kind: ChainErrorKind;
  readonly txHash: string | undefined;
  constructor(kind: ChainErrorKind, message: string, txHash?: string) {
    super(message);
    this.name = 'ChainError';
    this.kind = kind;
    this.txHash = txHash;
  }
}

const TRANSIENT_PATTERNS = [
  /fetch failed/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i,
  /\b(429|500|502|503|504)\b/,
  /too many requests|rate limit/i,
  /timeout|timed out|TIMEOUT_ERROR/i,
  /InvalidNonce|nonce.*(too|used)/i,
  /Transaction has expired|Expired/i,
  /server error|internal error|bad gateway|service unavailable/i,
  /UNKNOWN_BLOCK|not synced|shard.*unavailable/i,
];

const REFUSED_PATTERNS = [
  /Smart contract panicked/i,
  /FunctionCallError|ExecutionError|MethodNotFound|CodeDoesNotExist/i,
  /NotEnoughBalance|LackBalanceForState/i,
  /AccessKeyNotFound|InvalidSignature|NotEnoughAllowance/i,
];

/** Map any thrown value to a ChainError. Unknown errors count as transient:
 *  the keeper re-reads contract state before every retry, so a retry after
 *  an ambiguous failure is still idempotent. */
export function classifyError(e: unknown): ChainError {
  if (e instanceof ChainError) return e;
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (REFUSED_PATTERNS.some((p) => p.test(msg))) return new ChainError('refused', msg);
  if (TRANSIENT_PATTERNS.some((p) => p.test(msg))) return new ChainError('transient', msg);
  return new ChainError('transient', msg);
}
