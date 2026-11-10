// Transport abstractions: a read-only view provider and a transaction signer.
// Implementations: near.ts (JSON-RPC via near-api-js) and mock.ts (fixture-backed, offline).
import { AGENT_KEY_METHODS } from './constants.js';
import type { OsdEvent } from './events.js';

export interface ViewProvider {
  /** Call a view method; returns the JSON-decoded result. */
  view(contractId: string, method: string, args: object): Promise<unknown>;
}

export interface CallOptions {
  /** Gas in units (bigint). Defaults per method, see DEFAULT_GAS. */
  gas?: bigint;
  /** Attached deposit in yocto (bigint). */
  deposit?: bigint;
}

export interface CallOutcome<T = unknown> {
  txHash: string;
  /** JSON-decoded return value of the call (last receipt). */
  value: T;
  /** All log lines from the tx and its receipts. */
  logs: string[];
  /** Parsed NEP-297 `osd` events from `logs`. */
  events: OsdEvent[];
}

export type KeyKind = 'full_access' | 'function_call';

export interface TxSigner {
  /** Signer (predecessor) account id. */
  readonly accountId: string;
  readonly kind: KeyKind;
  call(contractId: string, method: string, args: object, opts: { gas: bigint; deposit: bigint }): Promise<CallOutcome>;
}

export class ScopeError extends Error {
  override name = 'ScopeError';
}

/**
 * Restrict a signer to what the agent function-call key can do (INTERFACE.md §4):
 * receiver = `contractId`, methods `commit`/`claim`, no deposit. Refuses client-side before signing,
 * so a misuse never costs gas or leaks a doomed tx.
 */
export function scopeToAgentKey(inner: TxSigner, contractId: string, methods: readonly string[] = AGENT_KEY_METHODS): TxSigner {
  return {
    accountId: inner.accountId,
    kind: 'function_call',
    async call(cid, method, args, opts) {
      if (cid !== contractId) throw new ScopeError(`agent key is scoped to ${contractId}, not ${cid}`);
      if (!methods.includes(method)) throw new ScopeError(`agent key may only call ${methods.join('/')}, not ${method}`);
      if (opts.deposit !== 0n) throw new ScopeError('function-call keys cannot attach a deposit');
      return inner.call(cid, method, args, opts);
    },
  };
}

const SECRET_KEY_RE = /\b(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{60,}/g;

/** Replace anything that looks like a NEAR secret key (`ed25519:<88 base58>`) with `<redacted>`. Public keys (~44 chars) survive. */
export function redactSecrets(s: string): string {
  return s.replace(SECRET_KEY_RE, '$1:<redacted>');
}
