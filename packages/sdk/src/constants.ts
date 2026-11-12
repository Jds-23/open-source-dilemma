// Constants from interfaces/contract-abi.json `constants` (interfaces-v7).
import type { CallMethod } from './types.js';

export const INTERFACE_VERSION = 'interfaces-v7';
/** `play_match` is refused below this prepaid gas (v7, F2); the keeper attaches 300 Tgas. */
export const MIN_PLAY_GAS_TGAS = 210;
export const CONTRACT_TESTNET = 'osd.baldingsucks7993.testnet';

export const AGENT_ACCOUNT_FUNDING = 200_000_000_000_000_000_000_000n; // 0.2 NEAR
export const MIN_REGISTER_DEPOSIT = 250_000_000_000_000_000_000_000n; // 0.25 NEAR
export const FC_KEY_ALLOWANCE = 250_000_000_000_000_000_000_000n; // 0.25 NEAR
export const MIN_OUTLAYER_DEPOSIT = 20_000_000_000_000_000_000_000n; // 0.02 NEAR
export const ONE_YOCTO = 1n;
export const STALE_PENDING_BLOCKS = 250;
export const MAX_AGENTS = 40;
export const MAX_PROMPT_BYTES = 4000;
export const MAX_PLAINTEXT_BYTES = 4033;
export const MAX_CIPHERTEXT_HEX = 8400;
export const STAKE_UNITS_PER_MATCH = 3;
export const PAGE_DEFAULT = 100;
export const PAGE_MAX = 200;
/** `settle_season` voids at most this many unfinished matches per call after the play deadline (returns `[]` until done). */
export const SETTLE_VOID_BATCH = 40;
/** `seal` confirm string (v5) and max keys per call. */
export const SEAL_CONFIRM = 'SEAL-FOREVER';
export const MAX_SEAL_KEYS = 32;
/** OutLayer secrets profile name accepted by `set_secrets` (v6). */
export const SECRETS_PROFILE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Payoff matrix `[a, b, pool]` in units (INTERFACE.md §2). */
export const PAYOFF = {
  CC: [3, 3, 0],
  DC: [5, 1, 0],
  CD: [1, 5, 0],
  DD: [1, 1, 4],
  FX: [0, 3, 3],
  XF: [3, 0, 3],
  FF: [0, 0, 6],
} as const;

/** Methods the agent function-call key may call (INTERFACE.md §4). */
export const AGENT_KEY_METHODS: readonly CallMethod[] = ['commit', 'claim'];

export const AGENT_NAME_RE = /^[a-z0-9_-]{2,16}$/;
export const FAMILY_RE = /^[a-z0-9_]{1,32}$/;

const TGAS = 1_000_000_000_000n;
/**
 * Default gas per call method (overridable per call). WS-1 recommended attachments (PR #18, measured in
 * sandbox at 40 agents): settle_season burns ~41 Tgas per void batch, play_match forwards the rest to OutLayer.
 */
export const DEFAULT_GAS: Record<CallMethod, bigint> = {
  register_agent: 50n * TGAS,
  fund_agent: 30n * TGAS,
  withdraw: 30n * TGAS,
  open_season: 300n * TGAS,
  commit: 30n * TGAS,
  close_commits: 30n * TGAS,
  schedule_round: 100n * TGAS,
  play_match: 300n * TGAS,
  refund_void: 30n * TGAS,
  settle_season: 300n * TGAS,
  claim: 30n * TGAS,
  publish_prompt: 50n * TGAS,
  seal: 100n * TGAS,
  set_secrets: 30n * TGAS,
};

export const NETWORKS = {
  testnet: { rpcUrl: 'https://test.rpc.fastnear.com', contractId: CONTRACT_TESTNET as string | undefined },
  mainnet: { rpcUrl: 'https://free.rpc.fastnear.com', contractId: undefined as string | undefined },
};
export type NetworkId = keyof typeof NETWORKS;

/** `<name>.<contract>`; throws if `name` does not match `^[a-z0-9_-]{2,16}$`. */
export function agentAccountId(name: string, contractId: string): string {
  if (!AGENT_NAME_RE.test(name)) throw new Error(`invalid agent name ${JSON.stringify(name)} (want ${AGENT_NAME_RE})`);
  return `${name}.${contractId}`;
}

const cmpBytes = (x: string, y: string): number => {
  const a = new TextEncoder().encode(x);
  const b = new TextEncoder().encode(y);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
};

/** Order a pair as the contract does (`a < b` by account-id bytes). */
export function orderPair(x: string, y: string): [string, string] {
  return cmpBytes(x, y) < 0 ? [x, y] : [y, x];
}

/** String form of a match key: `"<season_id>:<a>:<b>"` with `a < b`. */
export function matchKeyString(seasonId: number, x: string, y: string): string {
  const [a, b] = orderPair(x, y);
  return `${seasonId}:${a}:${b}`;
}

/** "1.5" NEAR -> yocto bigint (exact, up to 24 decimals). */
export function parseNear(near: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(near.trim());
  if (!m) throw new Error(`invalid NEAR amount ${JSON.stringify(near)}`);
  return BigInt(m[1]!) * 10n ** 24n + BigInt((m[2] ?? '').padEnd(24, '0') || '0');
}

/** yocto -> decimal NEAR string (trailing zeros trimmed). */
export function formatNear(yocto: bigint | string): string {
  const y = BigInt(yocto);
  const whole = y / 10n ** 24n;
  const frac = (y % 10n ** 24n).toString().padStart(24, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}
