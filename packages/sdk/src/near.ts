// NEAR JSON-RPC transport (near-api-js v7): views, full-access signer, agent function-call signer.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, getTransactionLastResult } from 'near-api-js';
import type { KeyPairString, Provider, TxExecutionStatus } from 'near-api-js';
import { eventsFromOutcome, logsFromOutcome } from './events.js';
import { scopeToAgentKey, redactSecrets, type CallOutcome, type TxSigner, type ViewProvider } from './transport.js';

export type RpcInput = string | Provider;

function toProvider(rpc: RpcInput): Provider {
  return typeof rpc === 'string' ? new JsonRpcProvider({ url: rpc }) : rpc;
}

/** Read-only views over NEAR JSON-RPC (`query` / `call_function`, final). */
export class RpcViewProvider implements ViewProvider {
  readonly provider: Provider;
  constructor(rpc: RpcInput) {
    this.provider = toProvider(rpc);
  }
  async view(contractId: string, method: string, args: object): Promise<unknown> {
    const r = await this.provider.callFunction({ contractId, method, args: args as Record<string, unknown> });
    return r ?? null;
  }
}

export interface KeySignerOptions {
  accountId: string;
  /** `ed25519:<base58>` secret key. Held in memory only; never logged. */
  secretKey: string;
  rpc: RpcInput;
  waitUntil?: TxExecutionStatus;
}

/** Signs with a single key pair. Wraps errors so secret material never appears in messages. */
class NearKeySigner implements TxSigner {
  readonly accountId: string;
  readonly kind = 'full_access' as const;
  readonly #account: Account;
  readonly #waitUntil: TxExecutionStatus;

  constructor(o: KeySignerOptions) {
    this.accountId = o.accountId;
    let signer: KeyPairSigner;
    try {
      signer = new KeyPairSigner(KeyPair.fromString(o.secretKey as KeyPairString));
    } catch {
      throw new Error(`invalid secret key for ${o.accountId} (expected "ed25519:<base58>")`);
    }
    this.#account = new Account(o.accountId, toProvider(o.rpc), signer);
    this.#waitUntil = o.waitUntil ?? 'EXECUTED_OPTIMISTIC';
  }

  async call(contractId: string, method: string, args: object, opts: { gas: bigint; deposit: bigint }): Promise<CallOutcome> {
    try {
      const outcome = await this.#account.signAndSendTransaction({
        receiverId: contractId,
        actions: [actions.functionCall(method, args, opts.gas, opts.deposit)],
        waitUntil: this.#waitUntil,
        throwOnFailure: true,
      });
      const o = outcome as unknown as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } };
      return {
        txHash: o.transaction?.hash ?? o.transaction_outcome?.id ?? '',
        value: getTransactionLastResult(outcome) ?? null,
        logs: logsFromOutcome(outcome),
        events: eventsFromOutcome(outcome),
      };
    } catch (e) {
      throw new Error(redactSecrets(`${method} failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
}

/** Full-access key signer (owner wallet: register_agent, fund_agent, withdraw, publish_prompt, keeper calls). */
export function fullAccessSigner(o: KeySignerOptions): TxSigner {
  return new NearKeySigner(o);
}

/**
 * Agent function-call key signer: the agent sub-account `<name>.<contract>` signing with the
 * key `register_agent` installed. Refuses anything but `commit`/`claim` on `contractId`, deposit 0.
 */
export function agentKeySigner(o: Omit<KeySignerOptions, 'accountId'> & { agentId: string; contractId: string }): TxSigner {
  return scopeToAgentKey(new NearKeySigner({ ...o, accountId: o.agentId }), o.contractId);
}

/** Fresh ed25519 key pair for `register_agent`'s `agent_public_key`. Store `secretKey` securely. */
export function generateAgentKey(): { publicKey: string; secretKey: string } {
  const kp = KeyPair.fromRandom('ed25519');
  return { publicKey: kp.getPublicKey().toString(), secretKey: kp.toString() };
}

/** Public key (`ed25519:<base58>`) for a secret key string. */
export function publicKeyOf(secretKey: string): string {
  return KeyPair.fromString(secretKey as KeyPairString).getPublicKey().toString();
}
