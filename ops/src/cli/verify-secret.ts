#!/usr/bin/env node
// Read-only check of the OutLayer secret profile the contract will use:
// accessor WasmHash(<hash>), profile name, Predecessor whitelist == [contract].
// Uses the public keystore view `list_user_secrets` (metadata only).

import { parseArgs } from 'node:util';
import { DEFAULT_RPC, NearRpc } from '../rpc.ts';
import { checkSecretRow, listUserSecrets } from '../secrets.ts';
import { DEFAULTS, die } from './common.ts';

async function main(): Promise<void> {
  const { values: v } = parseArgs({
    options: {
      owner: { type: 'string', default: DEFAULTS.signer },
      profile: { type: 'string' },
      'wasm-hash': { type: 'string' },
      contract: { type: 'string', default: DEFAULTS.contract },
      keystore: { type: 'string', default: DEFAULTS.keystore },
      network: { type: 'string', default: DEFAULTS.network },
      rpc: { type: 'string' },
    },
  });
  if (!v.profile || !v['wasm-hash']) die('usage: verify-secret --profile <p> --wasm-hash <sha256> [--owner <id>] [--contract <id>] [--keystore outlayer.testnet]');
  const rpc = new NearRpc(v.rpc ?? DEFAULT_RPC[v.network!] ?? die(`no default RPC for ${v.network}`));
  const rows = await listUserSecrets(rpc, v.keystore!, v.owner!);
  const res = checkSecretRow(rows, { profile: v.profile, wasmHash: v['wasm-hash'], contract: v.contract! });
  console.log(JSON.stringify({ ok: res.ok, owner: v.owner, profile: v.profile, wasm_hash: v['wasm-hash'], contract: v.contract, row: res.row, problems: res.problems }, null, 2));
  if (!res.ok) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
