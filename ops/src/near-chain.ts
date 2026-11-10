import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Account, JsonRpcProvider, actions, type KeyPairString } from 'near-api-js';
import { ChainError, classifyError, gasFor, type CallOptions, type Chain, type TxResult } from './chain.ts';
import { NearRpc } from './rpc.ts';

/**
 * Signing key, loaded at runtime and never logged:
 *  1. `NEAR_PRIVATE_KEY` env (`ed25519:...`), else
 *  2. the legacy keychain file `~/.near-credentials/<network>/<account>.json`
 *     (what `near ... sign-with-legacy-keychain` writes).
 */
export function loadSignerKey(network: string, accountId: string, env: NodeJS.ProcessEnv = process.env): KeyPairString {
  const fromEnv = env.NEAR_PRIVATE_KEY;
  if (fromEnv) return fromEnv as KeyPairString;
  const dir = env.NEAR_CREDENTIALS_DIR ?? join(homedir(), '.near-credentials');
  const file = join(dir, network, `${accountId}.json`);
  if (!existsSync(file)) {
    throw new Error(`no key for ${accountId}: set NEAR_PRIVATE_KEY or create ${file} (near account import-account ... save-to-legacy-keychain)`);
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { private_key?: string; secret_key?: string };
  const key = parsed.private_key ?? parsed.secret_key;
  if (!key) throw new Error(`${file} has no private_key`);
  return key as KeyPairString;
}

export interface NearChainOptions {
  network: string;
  rpcUrl: string;
  contractId: string;
  signerId: string;
  /** Omit for a view-only chain (dry-run planning). */
  key?: KeyPairString;
}

/** Real chain. `call` returns once the tx is included in a final block; the
 *  keeper then follows progress through views (the OutLayer callback lands
 *  ~18 blocks later, longer than an RPC wait would tolerate). */
export class NearChain implements Chain {
  readonly contractId: string;
  readonly signerId: string;
  readonly rpc: NearRpc;
  private readonly account: Account | null;

  constructor(o: NearChainOptions) {
    this.contractId = o.contractId;
    this.signerId = o.signerId;
    this.rpc = new NearRpc(o.rpcUrl);
    this.account = o.key ? new Account(o.signerId, new JsonRpcProvider({ url: o.rpcUrl }), o.key) : null;
  }

  view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    return this.rpc.view<T>(this.contractId, method, args);
  }

  head(): Promise<{ height: number; timestampNs: bigint }> {
    return this.rpc.head();
  }

  async sleep(ms: number): Promise<void> {
    await delay(ms);
  }

  async call(method: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<TxResult> {
    if (!this.account) throw new ChainError('refused', `view-only chain: refusing to send ${method}`);
    const { height } = await this.head();
    let res;
    try {
      res = await this.account.signAndSendTransaction({
        receiverId: this.contractId,
        actions: [actions.functionCall(method, args, opts.gas ?? gasFor(method), opts.depositYocto ?? 0n)],
        waitUntil: 'INCLUDED_FINAL',
        throwOnFailure: true,
      });
    } catch (e) {
      throw classifyError(e);
    }
    const txHash = (res as { transaction?: { hash?: string } }).transaction?.hash;
    if (!txHash) throw new ChainError('transient', `${method}: no tx hash in response`);
    return { txHash, block: height, value: successValue(res) };
  }
}

/** Decode `status.SuccessValue` (base64 JSON) of a final execution outcome; undefined if absent or not JSON. */
export function successValue(res: unknown): unknown {
  const sv = (res as { status?: { SuccessValue?: string } } | null)?.status?.SuccessValue;
  if (typeof sv !== 'string' || sv === '') return undefined;
  try {
    return JSON.parse(Buffer.from(sv, 'base64').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}
