import { classifyError, type ChainError } from './chain.ts';

export interface BackoffOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Returns [0,1). Injected so tests are deterministic. */
  random?: () => number;
  sleep: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, err: ChainError, delayMs: number) => void;
}

/** Full-jitter-ish exponential backoff: delay in [d/2, d), d = min(max, base·2^(n-1)). */
export function backoffDelay(attempt: number, o: Pick<BackoffOptions, 'baseDelayMs' | 'maxDelayMs' | 'random'>): number {
  const d = Math.min(o.maxDelayMs, o.baseDelayMs * 2 ** (attempt - 1));
  const r = (o.random ?? Math.random)();
  return Math.floor(d / 2 + (d / 2) * r);
}

/**
 * Run `fn` until it succeeds, a `refused` error occurs, or attempts run out.
 * `beforeRetry` runs before each retry; return false to stop (e.g. the match
 * is no longer `scheduled`, so re-sending would only burn gas).
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  o: BackoffOptions,
  beforeRetry?: (attempt: number) => Promise<boolean>,
): Promise<{ ok: true; value: T; attempts: number } | { ok: false; error: ChainError; attempts: number; stopped: boolean }> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return { ok: true, value: await fn(attempt), attempts: attempt };
    } catch (e) {
      const err = classifyError(e);
      if (err.kind === 'refused' || attempt >= o.maxAttempts) {
        return { ok: false, error: err, attempts: attempt, stopped: false };
      }
      const delay = backoffDelay(attempt, o);
      o.onRetry?.(attempt, err, delay);
      await o.sleep(delay);
      if (beforeRetry && !(await beforeRetry(attempt + 1))) {
        return { ok: false, error: err, attempts: attempt, stopped: true };
      }
    }
  }
}

/** Run `fn` over `items` with at most `limit` in flight. Results keep input order. */
export async function mapLimit<I, O>(items: readonly I[], limit: number, fn: (item: I, index: number) => Promise<O>): Promise<O[]> {
  if (limit < 1) throw new Error('concurrency limit must be >= 1');
  const out = new Array<O>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
