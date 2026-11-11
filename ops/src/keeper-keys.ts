// Extra signing keys for the keeper account (`keeper --keys K`).
//
// Why FULL-ACCESS keys: `play_match` needs an attached deposit (>= 0.02 NEAR
// for OutLayer, INTERFACE.md §6.1), and NEAR function-call access keys can
// never attach a deposit. So function-call keys scoped to the osd methods
// cannot sign play_match. The keeper instead adds K full-access keys to its
// own account and keeps them only on this machine, next to the main key:
//
//   ~/.near-credentials/<network>/keeper-keys/<account>/k01.json … kNN.json  (0600)
//
// Each key file is written BEFORE the AddKey tx, so a crash never leaves a key
// on chain that we cannot use (or delete). All missing keys go in ONE tx signed
// by the main key. `keeper --drop-keys` deletes them again (one DeleteKey tx).

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KeyPair, type KeyPairString } from 'near-api-js';

export interface KeeperKeyFile {
  account_id: string;
  public_key: string;
  private_key: KeyPairString;
}

export function keeperKeyDir(network: string, accountId: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.NEAR_CREDENTIALS_DIR ?? join(homedir(), '.near-credentials');
  return join(base, network, 'keeper-keys', accountId);
}

export function keeperKeyName(i: number): string {
  return `k${String(i + 1).padStart(2, '0')}`;
}

/** Load k01..kK, creating missing files (0600) when `create`. Returns the K keys in order. */
export function loadOrCreateKeeperKeys(dir: string, accountId: string, k: number, create: boolean): { keys: KeeperKeyFile[]; created: string[] } {
  const keys: KeeperKeyFile[] = [];
  const created: string[] = [];
  for (let i = 0; i < k; i++) {
    const file = join(dir, `${keeperKeyName(i)}.json`);
    if (existsSync(file)) {
      const f = JSON.parse(readFileSync(file, 'utf8')) as KeeperKeyFile;
      if (f.account_id !== accountId) throw new Error(`${file} belongs to ${f.account_id}, not ${accountId}`);
      keys.push(f);
      continue;
    }
    const kp = KeyPair.fromRandom('ed25519');
    const rec: KeeperKeyFile = { account_id: accountId, public_key: kp.getPublicKey().toString(), private_key: kp.toString() };
    if (create) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o600, flag: 'wx' });
    }
    keys.push(rec);
    created.push(keeperKeyName(i));
  }
  return { keys, created };
}

/** All local keeper key files (any K), for --drop-keys. */
export function listKeeperKeyFiles(dir: string): { file: string; key: KeeperKeyFile }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /^k\d{2,}\.json$/.test(n))
    .sort()
    .map((n) => ({ file: join(dir, n), key: JSON.parse(readFileSync(join(dir, n), 'utf8')) as KeeperKeyFile }));
}

export function removeKeyFile(file: string): void {
  rmSync(file, { force: true });
}

/** Which of `wanted` public keys are not yet on chain. */
export function missingKeys(wanted: readonly string[], onChain: readonly string[]): string[] {
  const have = new Set(onChain);
  return wanted.filter((k) => !have.has(k));
}
