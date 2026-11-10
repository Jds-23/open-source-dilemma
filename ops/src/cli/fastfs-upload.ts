#!/usr/bin/env node
// Upload a file (the referee WASM) to FastFS under a versioned path, then fetch
// it back and check the sha256. DRY RUN by default: prints path, URL, payload
// sizes and the txs it would send. `--execute` sends them.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Account, JsonRpcProvider, actions } from 'near-api-js';
import { FASTFS_METHOD, fastfsUrl, preparePayloads, sha256Hex, verifyUrl, versionedPath } from '../fastfs.ts';
import { loadSignerKey } from '../near-chain.ts';
import { DEFAULT_RPC } from '../rpc.ts';
import { banner, DEFAULTS, die } from './common.ts';

const USAGE = `usage: pnpm --filter @osd/ops fastfs-upload --file <path> --version <n> [options]

  --file <path>            file to upload (e.g. referee-wasm.wasm from the wasm-release workflow)
  --version <n>            path version; FastFS paths can't be overwritten, so bump it per upload attempt
  --expect-sha256 <hex>    refuse unless the file hashes to this (the CI-published sha256)
  --prefix <p>             path prefix (default osd-referee) → <prefix>/v<n>/<sha256>.wasm
  --sender <id>            uploading account (default ${DEFAULTS.signer}); part of the URL
  --receiver <id>          FastFS receiver (default outlayer.testnet); part of the URL
  --network <testnet>
  --rpc <url>
  --check-url              in dry run, also GET the URL to see whether the path is free
  --verify-only            skip upload; just fetch the URL and check the hash
  --execute                send the upload txs
  -h, --help`;

async function main(): Promise<void> {
  const { values: v } = parseArgs({
    options: {
      file: { type: 'string' },
      version: { type: 'string' },
      'expect-sha256': { type: 'string' },
      prefix: { type: 'string', default: 'osd-referee' },
      sender: { type: 'string', default: DEFAULTS.signer },
      receiver: { type: 'string', default: 'outlayer.testnet' },
      network: { type: 'string', default: DEFAULTS.network },
      rpc: { type: 'string' },
      'check-url': { type: 'boolean', default: false },
      'verify-only': { type: 'boolean', default: false },
      execute: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (v.help) return void console.log(USAGE);
  if (!v.file || !v.version) die(`--file and --version are required\n${USAGE}`);

  const content = readFileSync(v.file);
  const hash = sha256Hex(content);
  if (v['expect-sha256'] && v['expect-sha256'] !== hash) die(`sha256 ${hash} != --expect-sha256 ${v['expect-sha256']} (not the CI-built artifact?)`);
  const ext = v.file.endsWith('.wasm') ? 'wasm' : 'bin';
  const mime = ext === 'wasm' ? 'application/wasm' : 'application/octet-stream';
  const path = versionedPath(v.prefix!, v.version, hash, ext);
  const url = fastfsUrl(v.network!, v.sender!, v.receiver!, path);
  const payloads = preparePayloads(path, mime, content);

  console.log(JSON.stringify({ file: v.file, size: content.length, sha256: hash, relative_path: path, url, chunks: payloads.length, payload_bytes: payloads.map((p) => p.length) }, null, 2));

  if (v['verify-only']) return verify(url, hash, content.length);
  if (!v.execute) banner(false);

  if (v['check-url'] || v.execute) {
    const pre = await verifyUrl(url, hash, { attempts: 1, expectedSize: content.length });
    if (pre.ok) {
      console.error(`already served with the right hash: nothing to upload.\nWASM_URL=${url}\nWASM_HASH=${hash}`);
      return;
    }
    if (pre.reason === 'mismatch') die(`path already holds different bytes (sha256 ${pre.sha256}); bump --version`);
    console.error(`path free (HTTP ${pre.status}).`);
  }

  if (!v.execute) {
    for (const [i, p] of payloads.entries()) console.error(`would send ${v.sender} → ${v.receiver}::${FASTFS_METHOD} chunk ${i + 1}/${payloads.length} (${p.length} B, gas 1)`);
    console.error(`\nWASM_URL=${url}\nWASM_HASH=${hash}`);
    return;
  }

  banner(true);
  const rpcUrl = v.rpc ?? DEFAULT_RPC[v.network!] ?? die(`no default RPC for ${v.network}`);
  const acct = new Account(v.sender!, new JsonRpcProvider({ url: rpcUrl }), loadSignerKey(v.network!, v.sender!));
  for (const [i, p] of payloads.entries()) {
    // gas = 1: the call fails by design; the FastFS indexer reads the tx args.
    const r = await acct.signAndSendTransaction({
      receiverId: v.receiver!,
      actions: [actions.functionCall(FASTFS_METHOD, new Uint8Array(p), 1n, 0n)],
      waitUntil: 'INCLUDED_FINAL',
      throwOnFailure: false,
    });
    console.error(`chunk ${i + 1}/${payloads.length} tx ${r.transaction.hash}`);
  }
  await verify(url, hash, content.length);
}

async function verify(url: string, hash: string, size: number): Promise<void> {
  const r = await verifyUrl(url, hash, { attempts: 24, delayMs: 5_000, expectedSize: size });
  if (!r.ok) die(`verify failed: ${JSON.stringify(r)}${r.reason === 'mismatch' ? ' (path taken: bump --version)' : ''}`, 1);
  console.error(`verified ${url} (${r.size} B, sha256 ok after ${r.attempts} fetch(es))\nWASM_URL=${url}\nWASM_HASH=${hash}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
