// NEP-297 `osd` event parser (interfaces/events.md).
import type { AccountId, Commitment, Move, Parent, U128, U64, VoidReason } from './types.js';

export const EVENT_PREFIX = 'EVENT_JSON:';
export const EVENT_STANDARD = 'osd';

export interface OsdEventData {
  agent_registered: { agent_id: AccountId; owner: AccountId; name: string };
  season_opened: {
    season_id: number;
    pubkey: string;
    referee_template_hash: string;
    commit_deadline_ns: U64;
    entry_deposit_yocto: U128;
  };
  committed: { season_id: number; agent_id: AccountId; commitment: Commitment; family: string; parent: Parent };
  commits_closed: { season_id: number; n_entries: number; total_rounds: number; stake_per_agent_yocto: U128 };
  match_played: {
    season_id: number;
    a: AccountId;
    b: AccountId;
    a_move: Move;
    b_move: Move;
    a_payoff: number;
    b_payoff: number;
    pool_delta: number;
    sig_a_ok: boolean;
    sig_b_ok: boolean;
  };
  match_void: { season_id: number; a: AccountId; b: AccountId; reason: VoidReason };
  season_settled: {
    season_id: number;
    pool_yocto: U128;
    ranking: { agent_id: AccountId; rank: number | null; avg_payoff_milli: number; prize_yocto: U128 }[];
  };
  prompt_published: { season_id: number; agent_id: AccountId; commitment: Commitment };
  /** v5: `seal` succeeded (also emitted by the cards contract). */
  contract_sealed: { keys_deleted: string[]; block: number };
  /** v6: `set_secrets` changed the config secrets ref. */
  secrets_set: { owner: AccountId; profile: string; previous_owner: AccountId; previous_profile: string };
}

export type OsdEventName = keyof OsdEventData;
export const OSD_EVENT_NAMES: readonly OsdEventName[] = [
  'agent_registered',
  'season_opened',
  'committed',
  'commits_closed',
  'match_played',
  'match_void',
  'season_settled',
  'prompt_published',
  'contract_sealed',
  'secrets_set',
];

/** Discriminated union: narrow on `event`, then `data` is typed. `data` is `data[0]` of the raw log (always one object). */
export type OsdEvent = { [K in OsdEventName]: { standard: 'osd'; version: string; event: K; data: OsdEventData[K] } }[OsdEventName];

/**
 * Parse one log line. Returns null for non-event logs and for events of other standards.
 * Throws on a malformed `osd` event (bad JSON, unknown name, `data` not a 1-element array).
 */
export function parseEventLog(log: string): OsdEvent | null {
  if (!log.startsWith(EVENT_PREFIX)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(log.slice(EVENT_PREFIX.length));
  } catch {
    // other standards may log garbage; only fail loudly if it claims to be ours
    if (log.includes(`"standard":"${EVENT_STANDARD}"`)) throw new Error('malformed osd event JSON');
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { standard?: unknown; version?: unknown; event?: unknown; data?: unknown };
  if (r.standard !== EVENT_STANDARD) return null;
  if (typeof r.event !== 'string' || !(OSD_EVENT_NAMES as readonly string[]).includes(r.event)) {
    throw new Error(`unknown osd event ${JSON.stringify(r.event)}`);
  }
  if (!Array.isArray(r.data) || r.data.length !== 1 || typeof r.data[0] !== 'object') {
    throw new Error(`osd event ${r.event}: data must be a 1-element array`);
  }
  return { standard: 'osd', version: String(r.version ?? ''), event: r.event, data: r.data[0] } as OsdEvent;
}

/** Parse many log lines (e.g. a `.jsonl` stream or receipt logs), skipping non-osd lines. */
export function parseEventLogs(logs: Iterable<string>): OsdEvent[] {
  const out: OsdEvent[] = [];
  for (const l of logs) {
    const e = parseEventLog(l.trim());
    if (e) out.push(e);
  }
  return out;
}

/** Collect every log line from a NEAR tx outcome (transaction + all receipts). */
export function logsFromOutcome(outcome: unknown): string[] {
  const o = outcome as {
    transaction_outcome?: { outcome?: { logs?: string[] } };
    receipts_outcome?: { outcome?: { logs?: string[] } }[];
  };
  return [
    ...(o?.transaction_outcome?.outcome?.logs ?? []),
    ...(o?.receipts_outcome ?? []).flatMap((r) => r?.outcome?.logs ?? []),
  ];
}

/** All `osd` events in a NEAR tx outcome. */
export function eventsFromOutcome(outcome: unknown): OsdEvent[] {
  return parseEventLogs(logsFromOutcome(outcome));
}

/** Format an event back to its log line (mock chain; tests). */
export function formatEventLog<K extends OsdEventName>(event: K, data: OsdEventData[K], version = '1.0.0'): string {
  return EVENT_PREFIX + JSON.stringify({ standard: EVENT_STANDARD, version, event, data: [data] });
}

/** Type guard for narrowing: `events.filter(isEvent('match_played'))`. */
export function isEvent<K extends OsdEventName>(name: K) {
  return (e: OsdEvent): e is Extract<OsdEvent, { event: K }> => e.event === name;
}
