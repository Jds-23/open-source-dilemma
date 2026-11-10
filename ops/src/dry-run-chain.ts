import type { CallOptions, Chain, TxResult } from './chain.ts';

export interface PlannedCall {
  method: string;
  args: Record<string, unknown>;
  depositYocto: string;
  gas: string;
}

/**
 * Read-only planner: views and head() go to the wrapped chain (real RPC or a
 * mock), every `call` is recorded and answered with a fake hash. Nothing is
 * signed or sent. The keeper runs a single planning pass on top of this.
 */
export class DryRunChain implements Chain {
  readonly contractId: string;
  readonly signerId: string;
  readonly planned: PlannedCall[] = [];
  private readonly inner: Chain;

  constructor(inner: Chain) {
    this.inner = inner;
    this.contractId = inner.contractId;
    this.signerId = inner.signerId;
  }

  view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    return this.inner.view<T>(method, args);
  }

  head(): Promise<{ height: number; timestampNs: bigint }> {
    return this.inner.head();
  }

  sleep(ms: number): Promise<void> {
    return this.inner.sleep(ms);
  }

  async call(method: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<TxResult> {
    this.planned.push({ method, args, depositYocto: String(opts.depositYocto ?? 0n), gas: String(opts.gas ?? 0n) });
    const { height } = await this.inner.head();
    return { txHash: `dryrun-${String(this.planned.length).padStart(6, '0')}`, block: height };
  }
}
