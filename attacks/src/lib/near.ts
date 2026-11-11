// Minimal NEAR plumbing for the attack scripts: views, and a `send` that never
// throws on a refusal. It returns the tx hash (computed locally, so even a tx the
// RPC rejects before inclusion has one), the failure message, all receipt logs and
// gas burnt. Keys come from ~/.near-credentials/<network>/<account>.json at runtime
// and are never printed.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, baseEncode, encodeTransaction, type KeyPairString } from 'near-api-js';

export const NETWORK = process.env.OSD_NETWORK ?? 'testnet';
/** RPC endpoints, tried in turn on 429 / 5xx (the free endpoints rate-limit hard). */
export const RPC_URLS = (process.env.OSD_RPC_URL ?? 'https://rpc.testnet.fastnear.com,https://test.rpc.fastnear.com,https://near-testnet.drpc.org').split(',');
export const RPC_URL = RPC_URLS[0];
export const CONTRACT = process.env.OSD_CONTRACT_ID ?? 'osd.baldingsucks7993.testnet';
export const PARENT = process.env.OSD_PARENT ?? 'baldingsucks7993.testnet';
export const OUTLAYER = 'outlayer.testnet';
/** Outsider: no role in the game, funded by the parent. */
export const ATTACKER = `atk7.${PARENT}`;
/** Clone-farm owner (registers 4 agents, the 4th commit hits the per-owner cap). */
export const CLONE_OWNER = `clone7.${PARENT}`;

export const TGAS = 1_000_000_000_000n;
export const NEAR = 10n ** 24n;
export const milliNear = (n: number): bigint => (BigInt(n) * NEAR) / 1000n;

export function credsDir(): string {
  return process.env.NEAR_CREDENTIALS_DIR ?? join(homedir(), '.near-credentials');
}

export function keyFile(accountId: string): string {
  return join(credsDir(), NETWORK, `${accountId}.json`);
}

export function hasKey(accountId: string): boolean {
  return existsSync(keyFile(accountId));
}

export function loadKey(accountId: string): KeyPairString {
  const file = keyFile(accountId);
  if (!existsSync(file)) throw new Error(`no key file for ${accountId} (${file})`);
  const j = JSON.parse(readFileSync(file, 'utf8')) as { private_key?: string; secret_key?: string };
  const k = j.private_key ?? j.secret_key;
  if (!k) throw new Error(`${file} has no private_key`);
  return k as KeyPairString;
}

export const provider = new JsonRpcProvider({ url: RPC_URL });

let rpcId = 0;
export async function rpc<T>(method: string, params: unknown): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const url = RPC_URLS[(attempt - 1) % RPC_URLS.length];
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: `atk-${++rpcId}`, method, params }),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { result?: T; error?: unknown };
      if (j.error) throw new Error(`rpc ${method}: ${JSON.stringify(j.error)}`);
      return j.result as T;
    } catch (e) {
      const msg = (e as Error).message;
      if (attempt >= 8 || /rpc .*: \{/.test(msg)) throw e;
      await delay(Math.min(30_000, 1000 * 2 ** attempt));
    }
  }
}

export async function view<T>(method: string, args: Record<string, unknown> = {}, contract = CONTRACT): Promise<T> {
  const r = await rpc<{ result: number[] }>('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  return JSON.parse(Buffer.from(r.result).toString('utf8')) as T;
}

export async function balance(accountId: string): Promise<bigint | null> {
  try {
    const r = await rpc<{ amount: string }>('query', { request_type: 'view_account', finality: 'final', account_id: accountId });
    return BigInt(r.amount);
  } catch {
    return null;
  }
}

export async function head(): Promise<{ height: number; timestampNs: bigint }> {
  const b = await rpc<{ header: { height: number; timestamp_nanosec: string } }>('block', { finality: 'final' });
  return { height: b.header.height, timestampNs: BigInt(b.header.timestamp_nanosec) };
}

export interface ReceiptInfo {
  executor: string;
  gas_burnt: number;
  tokens_burnt: string;
  ok: boolean;
  failure?: string;
  logs: string[];
}

export interface TxOutcome {
  /** Locally computed (base58 sha256 of the borsh tx); valid even if the RPC rejected it. */
  txHash: string;
  /** False when the RPC/validator rejected the tx before inclusion (no receipts). */
  included: boolean;
  /** Top-level status succeeded. */
  ok: boolean;
  /** Top-level failure (or pre-inclusion rejection) message. */
  error?: string;
  /** Decoded SuccessValue (JSON when possible, else string). */
  value?: unknown;
  logs: string[];
  receipts: ReceiptInfo[];
  tokensBurnt: bigint;
  signer: string;
  receiver: string;
}

type Act = Parameters<Account['createSignedTransaction']>[0]['actions'][number];

/** Human-readable failure: the contract panic message if there is one, else the error kind. */
export function describeFailure(f: unknown): string {
  const s = JSON.stringify(f);
  const panic = /"ExecutionError":"((?:[^"\\]|\\.)*)"/.exec(s);
  if (panic) return panic[1].replace(/\\"/g, '"');
  const kinds = /"(MethodNameMismatch|ReceiverMismatch|RequiresFullAccess|DepositWithFunctionCall|NotEnoughAllowance|AccessKeyNotFound|NotEnoughBalance|InvalidAccessKeyError|ActorNoPermission|DeleteAccountWithLargeState)"/.exec(s);
  if (kinds) return `${kinds[1]}: ${s.slice(0, 300)}`;
  return s.slice(0, 400);
}

function decodeValue(b64: string | undefined): unknown {
  if (!b64) return undefined;
  const raw = Buffer.from(b64, 'base64').toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

interface RpcOutcome {
  status: { SuccessValue?: string; Failure?: unknown };
  transaction_outcome: { outcome: { gas_burnt: number; tokens_burnt: string } };
  receipts_outcome: { outcome: { executor_id: string; gas_burnt: number; tokens_burnt: string; logs: string[]; status: { Failure?: unknown } } }[];
}

export function parseOutcome(o: RpcOutcome, base: { txHash: string; signer: string; receiver: string }): TxOutcome {
  const receipts: ReceiptInfo[] = o.receipts_outcome.map((r) => ({
    executor: r.outcome.executor_id,
    gas_burnt: r.outcome.gas_burnt,
    tokens_burnt: r.outcome.tokens_burnt,
    ok: r.outcome.status.Failure === undefined,
    ...(r.outcome.status.Failure !== undefined ? { failure: describeFailure(r.outcome.status.Failure) } : {}),
    logs: r.outcome.logs,
  }));
  const tokensBurnt = BigInt(o.transaction_outcome.outcome.tokens_burnt) + receipts.reduce((a, r) => a + BigInt(r.tokens_burnt), 0n);
  const failed = o.status.Failure !== undefined;
  return {
    ...base,
    included: true,
    ok: !failed,
    ...(failed ? { error: describeFailure(o.status.Failure) } : {}),
    value: decodeValue(o.status.SuccessValue),
    logs: receipts.flatMap((r) => r.logs),
    receipts,
    tokensBurnt,
  };
}

/** Last nonce handed out per `signer:publicKey`, so concurrent sends from one key never collide. */
const lastNonce = new Map<string, bigint>();

/** Allocate a nonce: at least the chain's next nonce and above anything handed out before (sync). */
export function allocNonce(slot: string, chainNext: bigint): bigint {
  const prev = lastNonce.get(slot);
  const n = prev !== undefined && prev >= chainNext ? prev + 1n : chainNext;
  lastNonce.set(slot, n);
  return n;
}

/**
 * Sign with `signer`'s key file (or `key`) and send, waiting for FINAL (all receipts,
 * including an OutLayer yield/resume). Never throws on a refusal; network errors
 * are retried a few times with the same signed tx (same hash, idempotent).
 * Safe to call concurrently for one signer: nonces are allocated locally and a tx
 * overtaken by a later nonce (InvalidNonce) is re-signed with a fresh one.
 */
export async function send(
  signer: string,
  receiver: string,
  actionsList: Act[],
  opts: { key?: KeyPairString; waitUntil?: 'FINAL' | 'EXECUTED_OPTIMISTIC' | 'INCLUDED_FINAL' } = {},
): Promise<TxOutcome> {
  const secret = opts.key ?? loadKey(signer);
  const kp = KeyPair.fromString(secret);
  const publicKey = kp.getPublicKey();
  const acct = new Account(signer, provider, secret);
  const slot = `${signer}:${publicKey.toString()}`;
  let base = { txHash: '', signer, receiver };
  let lastErr = '';
  for (let resign = 0; resign < 6; resign++) {
    const tx = await acct.createTransaction({ receiverId: receiver, actions: actionsList, publicKey });
    tx.nonce = allocNonce(slot, tx.nonce);
    const { signedTransaction: signed } = await new KeyPairSigner(kp).signTransaction(tx);
    const txHash = baseEncode(createHash('sha256').update(encodeTransaction(signed.transaction)).digest());
    base = { txHash, signer, receiver };
    const b64 = Buffer.from(signed.encode()).toString('base64');
    let nonceClash = false;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const o = await rpc<RpcOutcome>('send_tx', { signed_tx_base64: b64, wait_until: opts.waitUntil ?? 'FINAL' });
        if (!o.receipts_outcome) return { ...base, included: true, ok: true, logs: [], receipts: [], tokensBurnt: 0n };
        return parseOutcome(o, base);
      } catch (e) {
        lastErr = (e as Error).message;
        if (/TIMEOUT_ERROR|timeout/i.test(lastErr)) {
          // Included but slow (OutLayer yield): poll the status instead of resending.
          const o = await waitTx(txHash, signer).catch(() => null);
          if (o) return o;
          continue;
        }
        if (/InvalidNonce/.test(lastErr)) {
          nonceClash = true;
          break;
        }
        if (/rpc send_tx: \{/.test(lastErr)) break; // invalid tx: a real refusal, don't resend
        await delay(1000 * attempt);
      }
    }
    if (!nonceClash) break;
    await delay(300 + Math.floor(Math.random() * 700));
  }
  return { ...base, included: false, ok: false, error: describeRpcError(lastErr), logs: [], receipts: [], tokensBurnt: 0n };
}

export function describeRpcError(msg: string): string {
  const short = msg.replace(/^rpc send_tx: /, '');
  const m = /"InvalidAccessKeyError":(\{[^{}]*(?:\{[^{}]*\}[^{}]*)?\}|"[A-Za-z]+")/.exec(short);
  if (m) return `InvalidAccessKeyError ${m[1].replace(/"/g, '')}`;
  const k = /"(NotEnoughBalance|NotEnoughAllowance|AccessKeyNotFound|InvalidNonce|Expired)"/.exec(short);
  return k ? `${k[1]}: ${short.slice(0, 200)}` : short.slice(0, 300);
}

export async function waitTx(txHash: string, sender: string, timeoutMs = 180_000): Promise<TxOutcome> {
  const t0 = Date.now();
  for (;;) {
    try {
      const o = await rpc<RpcOutcome & { transaction: { receiver_id: string } }>('EXPERIMENTAL_tx_status', {
        tx_hash: txHash,
        sender_account_id: sender,
        wait_until: 'FINAL',
      });
      return parseOutcome(o, { txHash, signer: sender, receiver: o.transaction.receiver_id });
    } catch (e) {
      if (Date.now() - t0 > timeoutMs) throw e;
      await delay(3000);
    }
  }
}

export const sleep = (ms: number): Promise<void> => delay(ms);

/** The OutLayer `execution_completed` event of a tx, if any. */
export function outlayerCompleted(o: TxOutcome): { success: boolean; error_message?: string; payment_charged?: string } | null {
  for (const l of o.logs) {
    const m = /^EVENT_JSON:(\{"standard":"near-outlayer".*"event":"execution_completed".*\})$/.exec(l);
    if (m) {
      const ev = JSON.parse(m[1]) as { data: { success: boolean; error_message?: string; payment_charged?: string }[] };
      return ev.data[0] ?? null;
    }
  }
  return null;
}
