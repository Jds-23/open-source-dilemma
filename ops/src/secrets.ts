// Verify an OutLayer secret profile from the public keystore view
// `outlayer.testnet::list_user_secrets` (metadata only: no values are exposed).

import type { NearRpc } from './rpc.ts';

export interface UserSecretInfo {
  accessor: unknown;
  profile: string;
  created_at: number;
  updated_at: number;
  storage_deposit: string;
  access: unknown;
}

export interface SecretCheck {
  ok: boolean;
  problems: string[];
  row: UserSecretInfo | null;
}

/** Walks pages the way outlayer-cli does: advance by the window, stop on an empty page. */
export async function listUserSecrets(rpc: Pick<NearRpc, 'view'>, keystore: string, owner: string, page = 200): Promise<UserSecretInfo[]> {
  const all: UserSecretInfo[] = [];
  for (let from = 0; from < 100_000; from += page) {
    const batch = await rpc.view<UserSecretInfo[]>(keystore, 'list_user_secrets', { account_id: owner, from_index: from, limit: page });
    if (!batch || batch.length === 0) return all;
    all.push(...batch);
  }
  return all;
}

function predecessorAccounts(access: unknown): string[] | null {
  // Shapes: {"Predecessor":{"condition":{"Whitelist":{"accounts":[...]}}}} or nested in {"Logic":{"conditions":[...]}}
  if (access === null || typeof access !== 'object') return null;
  const o = access as Record<string, unknown>;
  if ('Predecessor' in o) {
    const wl = ((o.Predecessor as Record<string, unknown>)?.condition as Record<string, unknown>)?.Whitelist as { accounts?: string[] } | undefined;
    return wl?.accounts ?? [];
  }
  for (const v of Object.values(o)) {
    const items = Array.isArray(v) ? v : [v];
    for (const it of items) {
      const r = predecessorAccounts(it);
      if (r) return r;
    }
  }
  return null;
}

/**
 * The row the contract will read must be: accessor WasmHash{hash}, profile as
 * configured, access = Predecessor whitelist of exactly [contract] (and the
 * row ANDed with nothing that admits others).
 */
export function checkSecretRow(rows: UserSecretInfo[], o: { profile: string; wasmHash: string; contract: string }): SecretCheck {
  const row =
    rows.find((r) => r.profile === o.profile && (r.accessor as { WasmHash?: { hash?: string } })?.WasmHash?.hash === o.wasmHash) ?? null;
  const problems: string[] = [];
  if (!row) {
    const sameProfile = rows.filter((r) => r.profile === o.profile).map((r) => JSON.stringify(r.accessor));
    problems.push(`no row with profile=${o.profile} and accessor WasmHash(${o.wasmHash})` + (sameProfile.length ? `; profile exists under ${sameProfile.join(', ')} (rebuilt WASM? re-store the secret)` : ''));
    return { ok: false, problems, row };
  }
  const accounts = predecessorAccounts(row.access);
  if (accounts === null) problems.push(`access has no Predecessor rule: ${JSON.stringify(row.access)} (anyone could run the WASM against the secret)`);
  else if (accounts.length !== 1 || accounts[0] !== o.contract) problems.push(`Predecessor whitelist is ${JSON.stringify(accounts)}, expected ["${o.contract}"]`);
  if (JSON.stringify(row.access).includes('AllowAll')) problems.push('access contains AllowAll');
  return { ok: problems.length === 0, problems, row };
}
