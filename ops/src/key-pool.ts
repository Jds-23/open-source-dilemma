// Parallel signing for one account: K access keys, each with its own nonce
// sequence. A tx is handed to the next free key round-robin, and each key has
// at most `perKey` txs in flight (default 1). With one tx in flight per key,
// nonces of a key are reserved and land strictly in order, so there is no
// nonce reuse and no "nonce must be larger" race between parallel txs.

export class KeyPool<K> {
  readonly keys: readonly K[];
  readonly perKey: number;
  private readonly busy: number[];
  private readonly waiters: (() => void)[] = [];
  private cursor = 0;
  /** Txs started per key (for logs and tests). */
  readonly used: number[];

  constructor(keys: readonly K[], perKey = 1) {
    if (keys.length === 0) throw new Error('KeyPool needs at least one key');
    if (perKey < 1) throw new Error('perKey must be >= 1');
    this.keys = keys;
    this.perKey = perKey;
    this.busy = keys.map(() => 0);
    this.used = keys.map(() => 0);
  }

  get size(): number {
    return this.keys.length;
  }

  /** Run `fn` with a key; waits while every key is at its in-flight cap. */
  async use<R>(fn: (key: K, index: number) => Promise<R>): Promise<R> {
    let i = this.acquire();
    while (i < 0) {
      await new Promise<void>((r) => this.waiters.push(r));
      i = this.acquire();
    }
    this.used[i] += 1;
    try {
      return await fn(this.keys[i], i);
    } finally {
      this.busy[i] -= 1;
      this.waiters.shift()?.();
    }
  }

  private acquire(): number {
    const n = this.keys.length;
    for (let step = 0; step < n; step++) {
      const i = (this.cursor + step) % n;
      if (this.busy[i] < this.perKey) {
        this.busy[i] += 1;
        this.cursor = (i + 1) % n;
        return i;
      }
    }
    return -1;
  }
}

/** In-flight cap per key so that K keys together carry `concurrency` txs. */
export function perKeyLimit(concurrency: number, keys: number): number {
  return Math.max(1, Math.ceil(concurrency / Math.max(1, keys)));
}
