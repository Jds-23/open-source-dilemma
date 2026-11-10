import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallOptions, Chain, TxResult } from '../src/chain.ts';
import { DEFAULT_KEEPER_OPTIONS, type KeeperOptions } from '../src/keeper.ts';
import { nearToYocto } from '../src/types.ts';

export const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'interfaces', 'fixtures');
export const OPS_FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

export function opts(over: Partial<KeeperOptions> = {}): KeeperOptions {
  return {
    ...DEFAULT_KEEPER_OPTIONS,
    openDepositYocto: nearToYocto('0.05'),
    playDepositYocto: nearToYocto('0.05'),
    random: () => 0.5,
    maxIterations: 10_000,
    ...over,
  };
}

/** Wraps a chain so `call` yields to the event loop; counts peak concurrency. */
export class SlowCalls implements Chain {
  readonly contractId: string;
  readonly signerId: string;
  inFlight = 0;
  peak = 0;
  private readonly inner: Chain;
  constructor(inner: Chain) {
    this.inner = inner;
    this.contractId = inner.contractId;
    this.signerId = inner.signerId;
  }
  view<T>(m: string, a: Record<string, unknown>): Promise<T> {
    return this.inner.view<T>(m, a);
  }
  head(): Promise<{ height: number; timestampNs: bigint }> {
    return this.inner.head();
  }
  sleep(ms: number): Promise<void> {
    return this.inner.sleep(ms);
  }
  async call(m: string, a: Record<string, unknown>, o?: CallOptions): Promise<TxResult> {
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      await new Promise((r) => setTimeout(r, 2));
      return await this.inner.call(m, a, o);
    } finally {
      this.inFlight -= 1;
    }
  }
}
