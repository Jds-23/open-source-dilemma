// In-memory model of the dilemma contract (INTERFACE.md §3, §6, §7), just
// enough for the keeper: lifecycle, round-robin schedule, one-shot play_match,
// void/refund, settle. Used by unit tests and `keeper --mock`. Virtual clock:
// sleep() advances time; 1 block per second.

import { ChainError, type CallOptions, type Chain, type TxResult } from './chain.ts';
import {
  matchKeyString,
  nearToYocto,
  SETTLE_VOID_BATCH,
  STALE_PENDING_BLOCKS,
  type OpenOverrides,
  type ContractConfig,
  type Entry,
  type LeaderboardRow,
  type Match,
  type MatchKey,
  type Move,
  type Season,
  type SeasonParams,
} from './types.ts';

export type Resolution = { kind: 'settled'; a_move: Move; b_move: Move } | { kind: 'void'; reason: string } | { kind: 'stuck' };
export type Resolver = (m: Match, ea: Entry, eb: Entry) => Resolution;

export interface Fault {
  method: string;
  /** How many upcoming calls of `method` fail. */
  times: number;
  /** `transient`: nothing happens on chain. `ambiguous`: the call DOES land, then the client sees a timeout.
   *  `silent_refusal`: the contract refuses but the client only sees inclusion (like waitUntil INCLUDED_FINAL). */
  mode: 'transient' | 'ambiguous' | 'silent_refusal';
  message?: string;
}

export const PAYOFF: Record<string, [number, number, number]> = {
  CC: [3, 3, 0],
  DC: [5, 1, 0],
  CD: [1, 5, 0],
  DD: [1, 1, 4],
  FC: [0, 3, 3],
  FD: [0, 3, 3],
  CF: [3, 0, 3],
  DF: [3, 0, 3],
  FF: [0, 0, 6],
};

const COOPERATIVE = /^(always_?c|alwaysc|tit_for_tat|tft|grim|fairbot|prudent)/;

/** Default: cooperative families play C, everything else D. */
export const familyResolver: Resolver = (_m, ea, eb) => ({
  kind: 'settled',
  a_move: COOPERATIVE.test(ea.family) ? 'C' : 'D',
  b_move: COOPERATIVE.test(eb.family) ? 'C' : 'D',
});

export interface MockOptions {
  contractId?: string;
  signerId?: string;
  owner?: string;
  startNs?: bigint;
  startBlock?: number;
  /** Blocks between play_match and on_match (spike: 18). */
  callbackBlocks?: number;
  /** Blocks between open_season and on_pubkey. */
  keyBlocks?: number;
  resolver?: Resolver;
  keyFails?: boolean;
  wasmUrl?: string;
  wasmHash?: string;
  secretsProfile?: string;
}

interface Pending {
  key: string;
  dueBlock: number;
}

export class MockChain implements Chain {
  readonly contractId: string;
  readonly signerId: string;
  readonly owner: string;
  nowNs: bigint;
  block: number;
  readonly seasons = new Map<number, Season>();
  readonly entries = new Map<number, Entry[]>();
  readonly matches = new Map<number, Match[]>();
  /** Accepted play_match per match key: must never exceed 1. */
  readonly playAccepted = new Map<string, number>();
  readonly refused: { method: string; reason: string }[] = [];
  readonly sent: { method: string; args: Record<string, unknown>; hash: string }[] = [];
  faults: Fault[] = [];
  resolver: Resolver;
  private readonly callbackBlocks: number;
  private readonly keyBlocks: number;
  private readonly keyFails: boolean;
  private pending: Pending[] = [];
  private keyDue: { season: number; dueBlock: number } | null = null;
  private currentSeason: number | null = null;
  private txN = 0;
  /** Contract-level pending carry-over (get_config.carry_over_yocto). */
  carryOverYocto = 0n;
  /** Contract config defaults (shape of interfaces/fixtures/config.json). */
  readonly wasmUrl: string;
  readonly wasmHash: string;
  readonly secretsProfile: string;
  /** Settle calls that returned `[]` (a void batch ran), for tests. */
  settleBatches = 0;
  private readonly prizes = new Map<number, Map<string, bigint>>();

  constructor(o: MockOptions = {}) {
    this.contractId = o.contractId ?? 'osd.baldingsucks7993.testnet';
    this.signerId = o.signerId ?? 'baldingsucks7993.testnet';
    this.owner = o.owner ?? this.signerId;
    this.nowNs = o.startNs ?? 1_794_316_329_000_000_000n;
    this.block = o.startBlock ?? 277_000_000;
    this.callbackBlocks = o.callbackBlocks ?? 18;
    this.keyBlocks = o.keyBlocks ?? 12;
    this.keyFails = o.keyFails ?? false;
    this.resolver = o.resolver ?? familyResolver;
    this.wasmUrl = o.wasmUrl ?? 'https://test.fastfs.io/baldingsucks7993.testnet/outlayer.testnet/osd-referee/v1/mock.wasm';
    this.wasmHash = o.wasmHash ?? 'mock';
    this.secretsProfile = o.secretsProfile ?? 'osd';
  }

  // ── test helpers ──────────────────────────────────────────────────────
  /** Put a season straight into `commit` with the given entries (commit is the SDK's job, not the keeper's). */
  seedSeason(params: SeasonParams, entries: Omit<Entry, 'season_id'>[]): number {
    const id = this.openSeasonInternal(params);
    const s = this.seasons.get(id)!;
    s.status = 'commit';
    s.pubkey = '02'.padEnd(66, '0');
    this.entries.set(
      id,
      entries.map((e) => ({ ...e, season_id: id })),
    );
    s.n_entries = entries.length;
    return id;
  }

  advance(ms: number): void {
    const blocks = Math.floor(ms / 1000);
    this.nowNs += BigInt(ms) * 1_000_000n;
    for (let i = 0; i < Math.max(blocks, 0); i++) {
      this.block += 1;
      this.tick();
    }
  }

  // ── Chain ─────────────────────────────────────────────────────────────
  async sleep(ms: number): Promise<void> {
    this.advance(ms);
  }

  async head(): Promise<{ height: number; timestampNs: bigint }> {
    return { height: this.block, timestampNs: this.nowNs };
  }

  async view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const sid = args.season_id as number;
    switch (method) {
      case 'get_config': {
        const c: ContractConfig = {
          owner: this.owner,
          outlayer_account: 'outlayer.testnet',
          wasm_url: this.wasmUrl,
          wasm_hash: this.wasmHash,
          secrets_owner: this.owner,
          secrets_profile: this.secretsProfile,
          nearai_signer: '00'.repeat(32),
          current_season_id: this.currentSeason,
          carry_over_yocto: String(this.carryOverYocto),
        };
        return c as T;
      }
      case 'get_season':
        return (structuredClone(this.seasons.get(sid)) ?? null) as T;
      case 'get_entries':
        return this.page(this.entries.get(sid) ?? [], args) as T;
      case 'get_matches': {
        let ms = this.matches.get(sid) ?? [];
        if (args.status) ms = ms.filter((m) => m.status === args.status);
        return this.page(ms, args) as T;
      }
      case 'get_leaderboard':
        return this.leaderboard(sid) as T;
      default:
        throw new ChainError('refused', `MethodNotFound: ${method}`);
    }
  }

  async call(method: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<TxResult> {
    const fi = this.faults.findIndex((f) => f.method === method && f.times > 0);
    const fault = fi >= 0 ? this.faults[fi] : undefined;
    if (fault) fault.times -= 1;
    if (fault?.mode === 'transient') throw new ChainError('transient', fault.message ?? 'fetch failed: ECONNRESET');

    const hash = `mocktx${String(++this.txN).padStart(5, '0')}`;
    const sentAt = this.block;
    let value: unknown;
    try {
      value = this.apply(method, args, opts.depositYocto ?? 0n);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.refused.push({ method, reason });
      if (fault?.mode === 'silent_refusal') {
        this.sent.push({ method, args, hash });
        return { txHash: hash, block: sentAt };
      }
      throw new ChainError('refused', `Smart contract panicked: ${reason}`, hash);
    }
    this.sent.push({ method, args, hash });
    if (fault?.mode === 'ambiguous') throw new ChainError('transient', fault.message ?? 'TimeoutError: transaction not confirmed in time');
    return { txHash: hash, block: sentAt, value };
  }

  // ── contract model ────────────────────────────────────────────────────
  private page<X>(xs: X[], args: Record<string, unknown>): X[] {
    const from = (args.from_index as number | undefined) ?? 0;
    const limit = Math.min((args.limit as number | undefined) ?? 100, 200);
    return structuredClone(xs.slice(from, from + limit));
  }

  private openSeasonInternal(params: SeasonParams, o: OpenOverrides = {}): number {
    const id = (this.currentSeason ?? 0) + 1;
    const unit = BigInt(params.unit_yocto);
    const carryIn = this.carryOverYocto;
    this.carryOverYocto = 0n;
    this.seasons.set(id, {
      season_id: id,
      status: 'pending_key',
      params: structuredClone(params),
      wasm: { url: o.wasm_url ?? this.wasmUrl, hash: o.wasm_hash ?? this.wasmHash },
      secrets_profile: o.secrets_profile ?? this.secretsProfile,
      pubkey: null,
      entry_deposit_yocto: String(BigInt(params.bond_yocto) + 3n * unit * BigInt(params.max_agents - 1)),
      stake_per_agent_yocto: null,
      n_entries: 0,
      total_rounds: 0,
      rounds_scheduled: 0,
      n_matches: 0,
      n_settled: 0,
      n_void: 0,
      pool_yocto: String(carryIn),
      carry_in_yocto: String(carryIn),
      carry_over_yocto: '0',
      opened_at_ns: String(this.nowNs),
      closed_at_ns: null,
      settled_at_ns: null,
    });
    this.matches.set(id, []);
    this.entries.set(id, []);
    this.currentSeason = id;
    return id;
  }

  private season(sid: unknown): Season {
    const s = this.seasons.get(sid as number);
    if (!s) throw new Error('unknown season');
    return s;
  }

  private findMatch(args: Record<string, unknown>): Match {
    const m = (this.matches.get(args.season_id as number) ?? []).find((x) => x.a === args.a && x.b === args.b);
    if (!m) throw new Error('unknown match');
    return m;
  }

  private apply(method: string, args: Record<string, unknown>, deposit: bigint): unknown {
    const min = nearToYocto('0.02');
    switch (method) {
      case 'open_season': {
        if (this.signerId !== this.owner) throw new Error('only owner');
        if (deposit < min) throw new Error('deposit < 0.02 NEAR');
        const cur = this.currentSeason === null ? null : this.seasons.get(this.currentSeason);
        if (cur && cur.status !== 'settled' && cur.status !== 'cancelled' && cur.status !== 'key_failed') {
          throw new Error('previous season not finished');
        }
        if ((args.wasm_url === undefined) !== (args.wasm_hash === undefined)) throw new Error('wasm_url and wasm_hash must be overridden together');
        const id = this.openSeasonInternal(args.params as SeasonParams, args as OpenOverrides);
        this.keyDue = { season: id, dueBlock: this.block + this.keyBlocks };
        return id;
      }
      case 'close_commits': {
        const s = this.season(args.season_id);
        if (s.status !== 'commit') throw new Error('status != commit');
        if (this.nowNs < BigInt(s.params.commit_deadline_ns)) throw new Error('before deadline');
        s.closed_at_ns = String(this.nowNs);
        const n = (this.entries.get(s.season_id) ?? []).length;
        s.n_entries = n;
        if (n < 2) {
          s.status = 'cancelled';
          return;
        }
        s.status = 'play';
        s.total_rounds = n % 2 === 0 ? n - 1 : n;
        s.stake_per_agent_yocto = String(3n * BigInt(s.params.unit_yocto) * BigInt(n - 1));
        return;
      }
      case 'schedule_round': {
        const s = this.season(args.season_id);
        if (s.status !== 'play') throw new Error('status != play');
        if (s.rounds_scheduled >= s.total_rounds) throw new Error('all rounds scheduled');
        const ids = (this.entries.get(s.season_id) ?? []).map((e) => e.agent_id);
        const pairs = roundRobinRound(ids, s.rounds_scheduled);
        const list = this.matches.get(s.season_id)!;
        for (const [x, y] of pairs) {
          const [a, b] = x < y ? [x, y] : [y, x];
          list.push(emptyMatch({ season_id: s.season_id, a, b }, s.rounds_scheduled));
        }
        s.rounds_scheduled += 1;
        s.n_matches = list.length;
        return;
      }
      case 'play_match': {
        if (deposit < min) throw new Error('deposit < 0.02 NEAR');
        const m = this.findMatch(args);
        if (m.status !== 'scheduled') throw new Error(`match not scheduled (${m.status})`);
        m.status = 'pending';
        m.requested_at_block = this.block;
        this.playAccepted.set(m.match_key, (this.playAccepted.get(m.match_key) ?? 0) + 1);
        this.pending.push({ key: m.match_key, dueBlock: this.block + this.callbackBlocks });
        return;
      }
      case 'refund_void': {
        const m = this.findMatch(args);
        const stale = m.status === 'pending' && m.requested_at_block !== null && this.block - m.requested_at_block > STALE_PENDING_BLOCKS;
        if (m.status !== 'void' && !stale) throw new Error(`match not void (${m.status})`);
        if (stale) {
          m.void_reason = 'stale_pending';
          this.pending = this.pending.filter((p) => p.key !== m.match_key);
          this.season(m.season_id).n_void += 1;
        }
        m.status = 'refunded';
        return;
      }
      case 'settle_season': {
        const s = this.season(args.season_id);
        if (s.status !== 'play') throw new Error('status != play');
        const ms = this.matches.get(s.season_id)!;
        const unfinished = ms.filter((m) => m.status === 'scheduled' || m.status === 'pending');
        if ((unfinished.length > 0 || s.rounds_scheduled < s.total_rounds) && this.nowNs < BigInt(s.params.play_deadline_ns)) {
          throw new Error('unfinished matches before play deadline');
        }
        // interfaces-v4: ≤ SETTLE_VOID_BATCH unfinished matches voided per call (receipt log limit); [] until done.
        if (unfinished.length > 0) {
          for (const m of unfinished.slice(0, SETTLE_VOID_BATCH)) {
            m.status = 'refunded';
            m.void_reason = 'deadline';
            s.n_void += 1;
          }
          if (unfinished.length > SETTLE_VOID_BATCH) {
            this.settleBatches += 1;
            return [];
          }
        }
        for (const m of ms) if (m.status === 'void') m.status = 'refunded';
        s.status = 'settled';
        s.settled_at_ns = String(this.nowNs);
        // Prizes floor(pool × bps / 10000) to ranked agents; the rest carries over to the next season.
        const pool = BigInt(s.pool_yocto);
        const ranked = this.leaderboard(s.season_id).filter((r) => r.rank !== null);
        const prizes = new Map<string, bigint>();
        s.params.prize_split_bps.forEach((bps, i) => {
          if (ranked[i]) prizes.set(ranked[i].agent_id, (pool * BigInt(bps)) / 10_000n);
        });
        this.prizes.set(s.season_id, prizes);
        const paid = [...prizes.values()].reduce((x, y) => x + y, 0n);
        s.carry_over_yocto = String(pool - paid);
        this.carryOverYocto += pool - paid;
        return this.leaderboard(s.season_id);
      }
      default:
        throw new Error(`MethodNotFound: ${method}`);
    }
  }

  private tick(): void {
    if (this.keyDue && this.block >= this.keyDue.dueBlock) {
      const s = this.seasons.get(this.keyDue.season)!;
      if (this.keyFails) s.status = 'key_failed';
      else {
        s.status = 'commit';
        s.pubkey = '03'.padEnd(66, 'a');
      }
      this.keyDue = null;
    }
    const due = this.pending.filter((p) => p.dueBlock <= this.block);
    if (due.length === 0) return;
    this.pending = this.pending.filter((p) => p.dueBlock > this.block);
    for (const p of due) {
      const [sidStr] = p.key.split(':');
      const sid = Number(sidStr);
      const m = this.matches.get(sid)!.find((x) => x.match_key === p.key)!;
      if (m.status !== 'pending') continue;
      const es = this.entries.get(sid)!;
      const r = this.resolver(m, es.find((e) => e.agent_id === m.a)!, es.find((e) => e.agent_id === m.b)!);
      const s = this.seasons.get(sid)!;
      if (r.kind === 'stuck') continue;
      m.settled_at_block = this.block;
      if (r.kind === 'void') {
        m.status = 'void';
        m.void_reason = r.reason;
        s.n_void += 1;
        continue;
      }
      const [ap, bp, pool] = PAYOFF[r.a_move + r.b_move];
      Object.assign(m, { status: 'settled', a_move: r.a_move, b_move: r.b_move, a_payoff: ap, b_payoff: bp, pool_delta: pool, sig_a_ok: r.a_move !== 'F', sig_b_ok: r.b_move !== 'F' });
      s.n_settled += 1;
      s.pool_yocto = String(BigInt(s.pool_yocto) + BigInt(pool) * BigInt(s.params.unit_yocto));
    }
  }

  private leaderboard(sid: number): LeaderboardRow[] {
    const es = this.entries.get(sid) ?? [];
    const owner = new Map(es.map((e) => [e.agent_id, e.owner]));
    const rows = es.map((e, idx) => {
      let n = 0;
      let tot = 0;
      for (const m of this.matches.get(sid) ?? []) {
        if (m.status !== 'settled' || (m.a !== e.agent_id && m.b !== e.agent_id)) continue;
        const opp = m.a === e.agent_id ? m.b : m.a;
        if (owner.get(opp) === e.owner) continue;
        n += 1;
        tot += m.a === e.agent_id ? m.a_payoff : m.b_payoff;
      }
      const prize = this.prizes.get(sid)?.get(e.agent_id) ?? 0n;
      return { idx, row: { agent_id: e.agent_id, owner: e.owner, family: e.family, matches_counted: n, total_payoff_counted: tot, avg_payoff_milli: n ? Math.floor((1000 * tot) / n) : 0, rank: null as number | null, prize_yocto: String(prize) } };
    });
    const ranked = rows.filter((r) => r.row.matches_counted > 0).sort((x, y) => y.row.avg_payoff_milli - x.row.avg_payoff_milli || y.row.total_payoff_counted - x.row.total_payoff_counted || x.idx - y.idx);
    ranked.forEach((r, i) => (r.row.rank = i + 1));
    return [...ranked, ...rows.filter((r) => r.row.matches_counted === 0)].map((r) => r.row);
  }
}

/** Circle-method round `r` over `ids` (commit order); a bye is dropped. */
export function roundRobinRound(ids: string[], r: number): [string, string][] {
  const xs: (string | null)[] = [...ids];
  if (xs.length % 2 === 1) xs.push(null);
  const n = xs.length;
  const rest = xs.slice(1);
  const k = r % (n - 1);
  const rot = [...rest.slice(rest.length - k), ...rest.slice(0, rest.length - k)];
  const arr = [xs[0], ...rot];
  const out: [string, string][] = [];
  for (let i = 0; i < n / 2; i++) {
    const x = arr[i];
    const y = arr[n - 1 - i];
    if (x !== null && y !== null) out.push([x, y]);
  }
  return out;
}

function emptyMatch(k: MatchKey, round: number): Match {
  return {
    ...k,
    round,
    match_key: matchKeyString(k),
    status: 'scheduled',
    a_move: null,
    b_move: null,
    a_payoff: 0,
    b_payoff: 0,
    pool_delta: 0,
    sig_a_ok: false,
    sig_b_ok: false,
    a_chat_id: null,
    b_chat_id: null,
    a_signed_text: null,
    b_signed_text: null,
    a_sig: null,
    b_sig: null,
    void_reason: null,
    requested_at_block: null,
    settled_at_block: null,
  };
}
