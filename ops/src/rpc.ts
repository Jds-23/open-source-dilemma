// Minimal NEAR JSON-RPC client for views and tx lookups. `fetch` is injectable,
// which is what the "mock RPC" tests use.

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export const DEFAULT_RPC: Record<string, string> = {
  testnet: 'https://test.rpc.fastnear.com',
  mainnet: 'https://free.rpc.fastnear.com',
};

interface RpcEnvelope<T> {
  result?: T;
  error?: { name?: string; cause?: { name?: string; info?: unknown }; message?: string; data?: unknown };
}

export class RpcError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'RpcError';
    this.status = status;
  }
}

export interface RpcRetryOptions {
  /** Attempts per request on HTTP 429 / 5xx / network errors (default 10, backoff capped at 15 s). Every request here is a read. */
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class NearRpc {
  readonly url: string;
  private readonly fetchFn: FetchLike;
  private readonly retry: Required<RpcRetryOptions>;
  private id = 0;

  constructor(url: string, fetchFn: FetchLike = globalThis.fetch as unknown as FetchLike, retry: RpcRetryOptions = {}) {
    this.url = url;
    this.fetchFn = fetchFn;
    this.retry = {
      attempts: retry.attempts ?? 10,
      baseDelayMs: retry.baseDelayMs ?? 500,
      sleep: retry.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  /**
   * One JSON-RPC call. Rate limits (429), 5xx and network failures are retried with
   * exponential backoff + jitter (views and tx lookups are idempotent); a parallel keeper
   * pass with 15 keys otherwise trips the public RPC's rate limit and aborts the run.
   */
  async request<T>(method: string, params: unknown): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.requestOnce<T>(method, params);
      } catch (e) {
        const retryable = e instanceof RpcError ? e.status === 429 || e.status >= 500 : !(e instanceof RpcError);
        if (!retryable || attempt >= this.retry.attempts) throw e;
        const d = Math.min(15_000, this.retry.baseDelayMs * 2 ** (attempt - 1));
        await this.retry.sleep(Math.floor(d / 2 + (d / 2) * Math.random()));
      }
    }
  }

  private async requestOnce<T>(method: string, params: unknown): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: `osd-${++this.id}`, method, params });
    const res = await this.fetchFn(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    if (!res.ok) throw new RpcError(`rpc ${method}: HTTP ${res.status}`, res.status);
    const env = (await res.json()) as RpcEnvelope<T>;
    if (env.error) {
      const cause = env.error.cause?.name ?? env.error.name ?? 'RPC_ERROR';
      throw new RpcError(`rpc ${method}: ${cause}: ${JSON.stringify(env.error.data ?? env.error.cause?.info ?? env.error.message)}`, 200);
    }
    if (env.result === undefined) throw new RpcError(`rpc ${method}: empty result`, 200);
    return env.result;
  }

  /** call_function view at final finality; decodes the JSON return value. */
  async view<T>(contractId: string, method: string, args: Record<string, unknown>): Promise<T> {
    const r = await this.request<{ result?: number[]; error?: string; logs?: string[] }>('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    if (r.error) throw new RpcError(`view ${method}: ${r.error}`, 200);
    const text = Buffer.from(r.result ?? []).toString('utf8');
    return (text === '' ? null : JSON.parse(text)) as T;
  }

  async head(): Promise<{ height: number; timestampNs: bigint }> {
    const b = await this.request<{ header: { height: number; timestamp_nanosec?: string; timestamp: number } }>('block', { finality: 'final' });
    const ts = b.header.timestamp_nanosec ?? String(b.header.timestamp);
    return { height: b.header.height, timestampNs: BigInt(ts) };
  }

  async accountExists(accountId: string): Promise<boolean> {
    try {
      await this.request('query', { request_type: 'view_account', finality: 'final', account_id: accountId });
      return true;
    } catch (e) {
      if (e instanceof RpcError && /UNKNOWN_ACCOUNT|does not exist/i.test(e.message)) return false;
      throw e;
    }
  }

  /** Public keys ("ed25519:…") of the account's access keys, with their permission kind. */
  async accessKeys(accountId: string): Promise<{ public_key: string; full_access: boolean }[]> {
    const r = await this.request<{ keys: { public_key: string; access_key: { permission: unknown } }[] }>('query', {
      request_type: 'view_access_key_list',
      finality: 'final',
      account_id: accountId,
    });
    return r.keys.map((k) => ({ public_key: k.public_key, full_access: k.access_key.permission === 'FullAccess' }));
  }

  /** Full tx status with receipts (for evidence: gas burnt, OutLayer charge). */
  async txStatus(txHash: string, senderId: string): Promise<TxStatus> {
    return this.request<TxStatus>('EXPERIMENTAL_tx_status', { tx_hash: txHash, sender_account_id: senderId, wait_until: 'NONE' });
  }
}

export interface Outcome {
  id: string;
  block_hash?: string;
  outcome: { logs: string[]; gas_burnt: number; tokens_burnt: string; executor_id: string; status: unknown };
}

export interface TxStatus {
  final_execution_status?: string;
  status?: unknown;
  transaction?: { hash: string; signer_id: string; receiver_id: string };
  transaction_outcome?: Outcome;
  receipts_outcome?: Outcome[];
}
