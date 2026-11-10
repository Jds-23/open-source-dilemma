import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_DIR = resolve(OPS_DIR, '..');
export const RUNS_DIR = join(OPS_DIR, 'runs');
export const FIXTURES_DIR = join(REPO_DIR, 'interfaces', 'fixtures');

export const DEFAULTS = {
  network: 'testnet',
  contract: 'osd.baldingsucks7993.testnet',
  signer: 'baldingsucks7993.testnet',
  keystore: 'outlayer.testnet',
};

export function die(msg: string, code = 2): never {
  console.error(`error: ${msg}`);
  process.exit(code);
}

export function intArg(v: string | undefined, name: string, dflt: number): number {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) die(`--${name} must be a non-negative integer`);
  return n;
}

export function banner(execute: boolean): void {
  console.error(execute ? '*** EXECUTE: transactions WILL be signed and sent ***' : '--- DRY RUN: nothing is signed or sent (pass --execute to send) ---');
}
