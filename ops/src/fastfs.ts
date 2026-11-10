// FastFS payload encoding (port of ops/fastfs/*.py and outlayer-cli
// `upload.rs`, which match fastnear/fastdata-drag-and-drop). A file is stored
// by sending `__fastdata_fastfs(<borsh>)` txs with gas = 1: the call fails on
// purpose, the indexer reads the args. Gotchas (docs/OPEN_SOURCE_DILEMMA.md §6):
//  - a path can't be overwritten → versioned paths (`osd-referee/v<N>/<sha256>.wasm`)
//  - partial chunks must start at 1 MiB offsets → CHUNK_SIZE is fixed

import { createHash } from 'node:crypto';

export const CHUNK_SIZE = 1 << 20;
/** outlayer-cli nonce epoch (2026-01-25T21:24:00Z). */
export const NONCE_EPOCH_S = 1_769_376_240;
export const FASTFS_METHOD = '__fastdata_fastfs';

export function sha256Hex(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}
function bstr(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([u32(b.length), b]);
}
function bvec(v: Uint8Array): Buffer {
  return Buffer.concat([u32(v.length), Buffer.from(v)]);
}

/** FastfsData::Simple { relative_path, content: Some({ mime_type, content }) } */
export function encodeSimple(relativePath: string, mime: string, content: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([0]), bstr(relativePath), Buffer.from([1]), bstr(mime), bvec(content)]);
}

/** FastfsData::Partial { relative_path, offset, full_size, mime_type, content_chunk, nonce } */
export function encodePartial(relativePath: string, offset: number, fullSize: number, mime: string, chunk: Uint8Array, nonce: number): Buffer {
  if (offset % CHUNK_SIZE !== 0) throw new Error(`partial chunk offset ${offset} is not a multiple of ${CHUNK_SIZE}`);
  return Buffer.concat([Buffer.from([1]), bstr(relativePath), u32(offset), u32(fullSize), bstr(mime), bvec(chunk), u32(nonce)]);
}

export function fastfsNonce(nowMs: number): number {
  return Math.floor(nowMs / 1000) - NONCE_EPOCH_S;
}

/** Simple payload for ≤ 1 MiB, else 1 MiB partial chunks sharing one nonce. */
export function preparePayloads(relativePath: string, mime: string, content: Uint8Array, nowMs = Date.now()): Buffer[] {
  if (content.length <= CHUNK_SIZE) return [encodeSimple(relativePath, mime, content)];
  const nonce = fastfsNonce(nowMs);
  const out: Buffer[] = [];
  for (let off = 0; off < content.length; off += CHUNK_SIZE) {
    out.push(encodePartial(relativePath, off, content.length, mime, content.subarray(off, off + CHUNK_SIZE), nonce));
  }
  return out;
}

export function fastfsHost(network: string): string {
  if (network === 'testnet') return 'test.fastfs.io';
  if (network === 'mainnet') return 'main.fastfs.io';
  throw new Error(`FastFS only knows testnet/mainnet, got ${network}`);
}

/** Versioned path: `<prefix>/v<version>/<sha256>.<ext>`. Bump `version` when a path is already taken. */
export function versionedPath(prefix: string, version: number | string, sha256: string, ext = 'wasm'): string {
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(prefix) || prefix.split('/').some((seg) => seg === '.' || seg === '..')) throw new Error(`bad prefix ${prefix}`);
  if (!/^[A-Za-z0-9._-]+$/.test(String(version))) throw new Error(`bad version ${version}`);
  return `${prefix}/v${version}/${sha256}.${ext}`;
}

export function fastfsUrl(network: string, sender: string, receiver: string, relativePath: string): string {
  return `https://${fastfsHost(network)}/${sender}/${receiver}/${relativePath}`;
}

export type GetBytes = (url: string) => Promise<{ status: number; body: Uint8Array }>;

export const httpGetBytes: GetBytes = async (url) => {
  const r = await fetch(url);
  return { status: r.status, body: new Uint8Array(await r.arrayBuffer()) };
};

export type VerifyResult =
  | { ok: true; sha256: string; size: number; attempts: number }
  | { ok: false; reason: 'missing' | 'mismatch'; status: number; sha256?: string; size?: number; attempts: number };

/** Fetch `url` until it serves bytes with `expectedSha256` (indexer lag) or attempts run out. */
export async function verifyUrl(url: string, expectedSha256: string, o: { get?: GetBytes; expectedSize?: number; attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<VerifyResult> {
  const get = o.get ?? httpGetBytes;
  const attempts = o.attempts ?? 12;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let last: VerifyResult = { ok: false, reason: 'missing', status: 0, attempts: 0 };
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await get(url);
      if (r.status === 200) {
        const h = sha256Hex(r.body);
        if (h === expectedSha256) return { ok: true, sha256: h, size: r.body.length, attempts: i };
        // Fewer bytes than expected: chunks still indexing, keep waiting.
        // Otherwise the path is taken by different bytes; waiting won't fix it.
        if (o.expectedSize === undefined || r.body.length >= o.expectedSize)
          return { ok: false, reason: 'mismatch', status: 200, sha256: h, size: r.body.length, attempts: i };
        last = { ok: false, reason: 'missing', status: 200, sha256: h, size: r.body.length, attempts: i };
      } else last = { ok: false, reason: 'missing', status: r.status, attempts: i };
    } catch {
      last = { ok: false, reason: 'missing', status: 0, attempts: i };
    }
    if (i < attempts) await sleep(o.delayMs ?? 5_000);
  }
  return last;
}
