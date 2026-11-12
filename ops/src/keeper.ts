// Season runner. Every step re-reads contract state first, so the keeper can be
// killed and re-run at any point: the contract is the source of truth, the
// JSONL journal only stops it from re-sending a tx that is still in flight.
//
//   open_season → (wait key) → [onCommitOpen: house commits, in parallel] →
//   wait commit deadline → close_commits → schedule_round × total_rounds (in
//   parallel) → play_match for every `scheduled` pair (concurrency limit,
//   backoff) → refund_void for void / stale pending → settle_season as soon as
//   every match is final (or after the play deadline), repeated while it
//   returns [] (interfaces-v4: after the play deadline it voids ≤ 40
//   unfinished matches per call before ranking)
//
// Fast seasons: a RELATIVE commit deadline ("+2m") is a commit window measured
// from the season pubkey's arrival. The contract needs an absolute deadline at
// open_season, before the pubkey exists, so the keeper sets
//   commit_deadline = chain_now + pubkeyWaitMs (estimate, 90 s) + window
// and logs the effective window once the pubkey lands.

import { gasFor, type Chain, type ChainError, type TxResult } from './chain.ts';
import { backoffDelay, mapLimit, withRetry } from './retry.ts';
import type { LogRecord, TxLog } from './txlog.ts';
import {
  PAGE_LIMIT,
  STALE_PENDING_BLOCKS,
  type ContractConfig,
  type LeaderboardRow,
  type Match,
  type OpenOverrides,
  type Season,
  type SeasonParams,
} from './types.ts';

export interface KeeperOptions {
  /** Resume/drive this season. Default: config.current_season_id. */
  seasonId?: number;
  /** Open a new season with these params if no season is active. Deadlines may be relative ("+2m"), see resolveOpenParams. */
  openParams?: SeasonParams;
  /** Commit window measured from pubkey arrival; overrides openParams.commit_deadline_ns. */
  commitWindowMs?: number;
  /** Estimate of open_season → on_pubkey (OutLayer derive_pubkey; 12 s in season 1, 34 s in season 3), added to a relative commit window. */
  pubkeyWaitMs: number;
  /** Runs once per run when the season is in `commit` with a pubkey (house commits). Errors are logged, not fatal. */
  onCommitOpen?: (s: Season) => Promise<void>;
  /** Per-season referee pin passed to open_season (wasm_url + wasm_hash together, secrets_profile). */
  openOverrides?: OpenOverrides;
  openDepositYocto: bigint;
  playDepositYocto: bigint;
  /** Gas for every call; default: per-method recommendation (`gasFor`). */
  gas?: bigint;
  /** Cap on settle_season calls in one settle phase (40 agents worst case: 20 void batches + the ranking call). */
  maxSettleCalls: number;
  /**
   * Parallel txs AND the cap on matches in flight at OutLayer (status `pending`). A pass only sends
   * play_match for `concurrency − pending` matches, so OutLayer never runs more referee jobs at once.
   */
  concurrency: number;
  /** Plays paused after a referee-side void (bad_output, callback_failed, llm_status_*); doubles per consecutive hit. */
  refereeCooldownMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  pollMs: number;
  /** Cap on play_match txs that were *included* for one match, across runs (contract refuses repeats anyway). */
  maxSendsPerMatch: number;
  /** After an included play_match, blocks to wait before "still scheduled" is read as "that tx failed". */
  graceBlocks: number;
  settle: boolean;
  /** Planning mode: do one pass over the current state and return (dry-run). */
  once: boolean;
  /** Journal outcome to write for successful sends ('dry_run' in dry-run mode). */
  okOutcome: 'ok' | 'dry_run';
  /** Safety valve for loops (tests); undefined = unlimited. */
  maxIterations?: number;
  random?: () => number;
}

/** Voids that are not OutLayer/referee trouble (no backoff): the attack/deadline paths. */
const NON_REFEREE_VOIDS = new Set(['duplicate_prompt', 'deadline', 'stale_pending', 'commitment_mismatch']);

export const DEFAULT_KEEPER_OPTIONS: Omit<KeeperOptions, 'openDepositYocto' | 'playDepositYocto'> = {
  maxSettleCalls: 32,
  pubkeyWaitMs: 90_000,
  concurrency: 5,
  refereeCooldownMs: 30_000,
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  pollMs: 5_000,
  maxSendsPerMatch: 2,
  graceBlocks: 10,
  settle: true,
  once: false,
  okOutcome: 'ok',
};

export interface KeeperResult {
  seasonId: number | null;
  status: Season['status'] | 'none';
  playSent: number;
  refundSent: number;
  settleCalls: number;
  skipped: number;
  failed: number;
  leaderboard?: LeaderboardRow[];
}

const FINAL = new Set(['settled', 'refunded']);

export class Keeper {
  private readonly chain: Chain;
  private readonly log: TxLog;
  private readonly o: KeeperOptions;
  private readonly seenFinal = new Set<string>();
  private readonly exhaustedWarned = new Set<string>();
  private commitHookDone = false;
  private readonly marked = new Set<string>();
  /** Adaptive OutLayer concurrency: halved on referee-side voids, +1 per clean pass, ≤ o.concurrency. */
  private playCap = 0;
  private pausePasses = 0;
  private refereeHits = 0;
  private result: KeeperResult = { seasonId: null, status: 'none', playSent: 0, refundSent: 0, settleCalls: 0, skipped: 0, failed: 0 };

  constructor(chain: Chain, log: TxLog, o: KeeperOptions) {
    this.chain = chain;
    this.log = log;
    this.o = o;
    this.playCap = Math.max(1, o.concurrency);
    for (const r of log.records()) if (r.kind === 'info' && r.msg === 'match_final' && typeof r.match_key === 'string') this.seenFinal.add(r.match_key);
  }

  async run(): Promise<KeeperResult> {
    let sid = await this.resolveSeason();
    let iterations = 0;
    for (;;) {
      if (this.o.maxIterations !== undefined && ++iterations > this.o.maxIterations) {
        this.note('warn', null, 'max iterations reached');
        return this.result;
      }
      if (sid === null) {
        if (!this.o.openParams) {
          this.note('info', null, 'no active season and no --open params: nothing to do');
          return this.result;
        }
        sid = await this.openSeason();
        if (sid === null) return this.result;
        continue;
      }
      const s = await this.chain.view<Season | null>('get_season', { season_id: sid });
      if (!s) throw new Error(`season ${sid} not found`);
      this.result.seasonId = sid;
      this.result.status = s.status;
      switch (s.status) {
        case 'pending_key':
          this.note('phase', sid, 'waiting for on_pubkey (OutLayer derive_pubkey)');
          if (this.o.once) return this.result;
          await this.chain.sleep(this.o.pollMs);
          break;
        case 'key_failed':
          this.note('error', sid, 'season key derivation failed (status key_failed); open a new season');
          return this.result;
        case 'commit':
          await this.commitOpen(s);
          if (!(await this.closeCommits(s))) return this.result;
          break;
        case 'play':
          if (s.rounds_scheduled < s.total_rounds) {
            if (!(await this.scheduleRounds(s))) return this.result;
            if (this.o.once) return this.result;
            break;
          }
          if (await this.playPass(s)) return this.result;
          break;
        case 'settled':
        case 'cancelled': {
          this.note('phase', sid, `season ${s.status}`);
          if (s.status === 'settled') {
            this.result.leaderboard = await this.chain.view<LeaderboardRow[]>('get_leaderboard', { season_id: sid });
            this.log.write({ kind: 'info', season_id: sid, msg: 'leaderboard', rows: this.result.leaderboard });
          }
          return this.result;
        }
      }
    }
  }

  // ── phases ────────────────────────────────────────────────────────────

  private async resolveSeason(): Promise<number | null> {
    if (this.o.seasonId !== undefined) return this.o.seasonId;
    const cfg = await this.chain.view<ContractConfig>('get_config', {});
    const cur = cfg.current_season_id;
    if (cur === null) return null;
    const s = await this.chain.view<Season | null>('get_season', { season_id: cur });
    if (!s) return null;
    const active = !['settled', 'cancelled', 'key_failed'].includes(s.status);
    if (active) {
      if (this.o.openParams) this.note('warn', cur, `season ${cur} is still ${s.status}: resuming it instead of opening a new one`);
      return cur;
    }
    return this.o.openParams ? null : cur;
  }

  private async openSeason(): Promise<number | null> {
    const before = (await this.chain.view<ContractConfig>('get_config', {})).current_season_id;
    const ov = this.o.openOverrides ?? {};
    if ((ov.wasm_url === undefined) !== (ov.wasm_hash === undefined)) throw new Error('open overrides: wasm_url and wasm_hash go together');
    const head = await this.chain.head();
    const params = resolveOpenParams(this.o.openParams!, head.timestampNs, this.o);
    this.note('info', null, `open params: commit_deadline in ${Number((BigInt(params.commit_deadline_ns) - head.timestampNs) / 1_000_000_000n)} s, play_deadline in ${Number((BigInt(params.play_deadline_ns) - head.timestampNs) / 1_000_000_000n)} s (chain time)`);
    const args = { params, ...ov };
    let sent: { tx: TxResult; attempt: number } | null = null;
    const ok = await this.send(
      null,
      'open_season',
      args,
      this.o.openDepositYocto,
      async () => {
        const now = (await this.chain.view<ContractConfig>('get_config', {})).current_season_id;
        return now === before; // retry only if the open did not land
      },
      // The new season id is only known once the open lands, so the ok record is written
      // below, into that season's journal (<id>.jsonl), not keeper.jsonl.
      (tx, attempt) => {
        sent = { tx, attempt };
      },
    );
    if (!ok) return null;
    const logOpen = (sid: number | null): void => {
      if (!sent) return;
      const { tx, attempt } = sent;
      sent = null;
      this.logTx(sid, 'open_season', args, tx, attempt, this.o.openDepositYocto);
    };
    if (this.o.once) {
      logOpen(null);
      this.note('phase', null, 'dry-run: would wait for the new season id');
      return null;
    }
    for (let i = 0; i < 120; i++) {
      const now = (await this.chain.view<ContractConfig>('get_config', {})).current_season_id;
      if (now !== null && now !== before) {
        logOpen(now);
        this.note('phase', now, `opened season ${now}`);
        await this.mark(now, 'opened');
        return now;
      }
      await this.chain.sleep(this.o.pollMs);
    }
    logOpen(null);
    throw new Error('open_season sent but current_season_id never changed');
  }

  /** First sight of the season in `commit`: log the effective window, run the house-commit hook once. */
  private async commitOpen(s: Season): Promise<void> {
    if (this.o.once || !s.pubkey) return;
    if (!this.marked.has(`${s.season_id}:pubkey`)) {
      const head = await this.mark(s.season_id, 'pubkey');
      const left = Number((BigInt(s.params.commit_deadline_ns) - head.timestampNs) / 1_000_000n);
      this.note(left < 60_000 ? 'warn' : 'info', s.season_id, `pubkey landed ${Number((head.timestampNs - BigInt(s.opened_at_ns)) / 1_000_000n) / 1000} s after open; effective commit window ${left / 1000} s`);
    }
    if (this.o.onCommitOpen && !this.commitHookDone) {
      this.commitHookDone = true;
      try {
        await this.o.onCommitOpen(s);
      } catch (e) {
        this.note('error', s.season_id, `commit hook failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      await this.mark(s.season_id, 'commits_sent');
    }
  }

  /** Returns false when the run should stop (dry-run, cancelled). */
  private async closeCommits(s: Season): Promise<boolean> {
    const deadline = BigInt(s.params.commit_deadline_ns);
    const head = await this.chain.head();
    if (head.timestampNs < deadline) {
      const waitMs = Number((deadline - head.timestampNs) / 1_000_000n) + 1_000;
      this.note('phase', s.season_id, `commit window open (${s.n_entries} entries); deadline in ${Math.ceil(waitMs / 1000)} s`);
      if (this.o.once) return false;
      await this.chain.sleep(Math.min(waitMs, Math.max(this.o.pollMs, 60_000)));
      return true;
    }
    const ok = await this.send(s.season_id, 'close_commits', { season_id: s.season_id }, 0n, () => this.statusIs(s.season_id, 'commit'));
    if (ok && !this.o.once) await this.mark(s.season_id, 'closed');
    if (!ok && !this.o.once) await this.chain.sleep(this.o.pollMs);
    return !this.o.once;
  }

  /**
   * schedule_round takes no round index (each call schedules the next one), so the remaining rounds go out in
   * parallel (≤ concurrency). A retry is sent only while fewer rounds are scheduled than this pass needs; an
   * extra call is merely refused ("all rounds scheduled").
   */
  private async scheduleRounds(s: Season): Promise<boolean> {
    const remaining = s.total_rounds - s.rounds_scheduled;
    this.note('phase', s.season_id, `scheduling ${remaining} round(s)`);
    const oks = await mapLimit(Array.from({ length: remaining }), this.o.concurrency, () =>
      this.send(s.season_id, 'schedule_round', { season_id: s.season_id }, 0n, async () => {
        const now = await this.chain.view<Season | null>('get_season', { season_id: s.season_id });
        return now !== null && now.status === 'play' && now.rounds_scheduled < now.total_rounds;
      }),
    );
    if (this.o.once) return true;
    if (oks.some((x) => !x)) {
      await this.chain.sleep(this.o.pollMs);
      return true; // the main loop re-reads rounds_scheduled
    }
    // Views are at final finality and lag the INCLUDED_FINAL sends by a few blocks: wait until the view shows
    // every round, or the next pass would re-send schedule_round (refused "all rounds scheduled", gas burnt).
    for (let i = 0; i < 30; i++) {
      const now = await this.chain.view<Season | null>('get_season', { season_id: s.season_id });
      if (!now || now.status !== 'play' || now.rounds_scheduled >= now.total_rounds) break;
      await this.chain.sleep(1_000);
    }
    await this.mark(s.season_id, 'scheduled');
    return true;
  }

  /** One sweep over all matches. Returns true when the run is finished. */
  private async playPass(s: Season): Promise<boolean> {
    const sid = s.season_id;
    const matches = await this.allMatches(sid);
    const head = await this.chain.head();
    const fresh = this.recordFinals(sid, matches, head.height);
    this.adaptPlayCap(sid, fresh);
    const pastDeadline = head.timestampNs >= BigInt(s.params.play_deadline_ns);

    const inFlight = matches.filter((m) => m.status === 'pending').length;
    const slots = this.pausePasses > 0 ? 0 : Math.max(0, this.playCap - inFlight);
    if (this.pausePasses > 0) this.pausePasses -= 1;
    const toPlay = pastDeadline ? [] : matches.filter((m) => this.eligibleToPlay(m, head.height)).slice(0, slots);
    const toRefund = matches.filter((m) => this.eligibleToRefund(m, head.height));
    const counts = countBy(matches.map((m) => m.status));
    this.note('phase', sid, `play pass: ${JSON.stringify(counts)}; to play ${toPlay.length}, to refund ${toRefund.length}`);

    await mapLimit(toPlay, this.o.concurrency, (m) => this.playOne(m));
    await mapLimit(toRefund, this.o.concurrency, (m) =>
      this.send(sid, 'refund_void', { season_id: sid, a: m.a, b: m.b }, 0n, () => this.matchStatusIn(m, ['void', 'pending'])).then((ok) => {
        if (ok) this.result.refundSent += 1;
      }),
    );

    const finished = matches.every((m) => FINAL.has(m.status)) && toRefund.length === 0;
    if (finished && !this.o.once) await this.mark(sid, 'all_final');
    if ((finished || pastDeadline) && this.o.settle) {
      if (pastDeadline && !finished) this.note('warn', sid, 'play deadline passed: settle_season voids unfinished matches (≤ 40 per call)');
      await this.settle(sid);
      return this.o.once;
    }
    if (finished && !this.o.settle) {
      this.note('phase', sid, 'all matches final; --no-settle given, stopping');
      return true;
    }
    if (this.o.once) return true;
    await this.chain.sleep(this.o.pollMs);
    return false;
  }

  /**
   * interfaces-v4: settle_season returns `[]` while it is still voiding unfinished matches in batches,
   * so call it until it returns the ranking (or the view says `settled`), backing off between calls.
   */
  private async settle(sid: number): Promise<void> {
    for (let i = 1; i <= this.o.maxSettleCalls; i++) {
      const tx = await this.send(sid, 'settle_season', { season_id: sid }, 0n, () => this.statusIs(sid, 'play'));
      if (this.o.once) return;
      if (!tx) {
        await this.chain.sleep(this.o.pollMs);
        return; // refused / failed: the main loop re-reads the season
      }
      this.result.settleCalls += 1;
      if (Array.isArray(tx.value) && tx.value.length > 0) {
        await this.mark(sid, 'settled');
        return;
      }
      if (!(await this.statusIs(sid, 'play'))) {
        await this.mark(sid, 'settled');
        return; // settled (possibly with an empty ranking)
      }
      const wait = backoffDelay(i, this.o);
      this.note('phase', sid, `settle_season call ${i} voided a batch (returned []); calling again in ${wait} ms`);
      await this.chain.sleep(wait);
    }
    this.note('warn', sid, `settle_season still not final after ${this.o.maxSettleCalls} calls; will retry on the next pass`);
  }

  private async playOne(m: Match): Promise<void> {
    const ok = await this.send(m.season_id, 'play_match', { season_id: m.season_id, a: m.a, b: m.b }, this.o.playDepositYocto, () => this.matchStatusIn(m, ['scheduled']));
    if (ok) this.result.playSent += 1;
  }

  // ── idempotency ───────────────────────────────────────────────────────

  private sendsFor(method: string, m: Match): LogRecord[] {
    return this.log
      .records()
      .filter((r) => r.kind === 'tx' && r.method === method && r.outcome === 'ok' && r.args?.season_id === m.season_id && r.args?.a === m.a && r.args?.b === m.b);
  }

  private eligibleToPlay(m: Match, height: number): boolean {
    if (m.status !== 'scheduled') return false;
    const sends = this.sendsFor('play_match', m);
    if (sends.length === 0) return true;
    const last = Math.max(...sends.map((r) => r.block ?? 0));
    if (height - last <= this.o.graceBlocks) {
      this.result.skipped += 1;
      return false; // in flight: give the tx time to execute
    }
    if (sends.length >= this.o.maxSendsPerMatch) {
      if (!this.exhaustedWarned.has(m.match_key)) {
        this.exhaustedWarned.add(m.match_key);
        this.note('warn', m.season_id, `${m.match_key}: ${sends.length} play_match tx included but still scheduled; giving up (settle after deadline voids it)`);
      }
      this.result.skipped += 1;
      return false;
    }
    this.note('warn', m.season_id, `${m.match_key}: previous play_match included at block ${last} but match still scheduled; re-sending`);
    return true;
  }

  private eligibleToRefund(m: Match, height: number): boolean {
    const stale = m.status === 'pending' && m.requested_at_block !== null && height - m.requested_at_block > STALE_PENDING_BLOCKS;
    if (m.status !== 'void' && !stale) return false;
    const sends = this.sendsFor('refund_void', m);
    if (sends.length === 0) return true;
    const last = Math.max(...sends.map((r) => r.block ?? 0));
    return height - last > this.o.graceBlocks && sends.length < this.o.maxSendsPerMatch;
  }

  /**
   * AIMD on OutLayer load. Season 6 (testnet, 15 keys, no in-flight cap) sent all 300 play_match at once and
   * 102 matches voided as `bad_output` (the referee WASM trapped ~1 s in, in bursts). Any referee-side void
   * halves the cap and pauses new plays; a pass with settles and no such void raises the cap by one.
   */
  private adaptPlayCap(sid: number, fresh: Match[]): void {
    const refereeVoids = fresh.filter((m) => m.status === 'void' && !NON_REFEREE_VOIDS.has(m.void_reason ?? ''));
    if (refereeVoids.length > 0) {
      this.refereeHits += 1;
      const cooldown = Math.min(this.o.maxDelayMs * 4, this.o.refereeCooldownMs * 2 ** (this.refereeHits - 1));
      this.playCap = Math.max(1, Math.floor(this.playCap / 2));
      this.pausePasses = Math.max(1, Math.ceil(cooldown / Math.max(1, this.o.pollMs)));
      this.note('warn', sid, `${refereeVoids.length} referee-side void(s) (${[...new Set(refereeVoids.map((m) => m.void_reason))].join(', ')}): in-flight cap → ${this.playCap}, plays paused ${cooldown / 1000} s`);
    } else if (fresh.some((m) => m.status === 'settled')) {
      this.refereeHits = 0;
      this.playCap = Math.min(Math.max(1, this.o.concurrency), this.playCap + 1);
    }
  }

  private recordFinals(sid: number, matches: Match[], height: number): Match[] {
    const fresh: Match[] = [];
    for (const m of matches) {
      if (!['settled', 'void', 'refunded'].includes(m.status) || this.seenFinal.has(m.match_key)) continue;
      this.seenFinal.add(m.match_key);
      fresh.push(m);
      this.log.write({
        kind: 'info',
        season_id: sid,
        msg: 'match_final',
        match_key: m.match_key,
        status: m.status,
        a_move: m.a_move,
        b_move: m.b_move,
        void_reason: m.void_reason,
        requested_at_block: m.requested_at_block,
        settled_at_block: m.settled_at_block,
        observed_at_block: height,
      });
    }
    return fresh;
  }

  // ── plumbing ──────────────────────────────────────────────────────────

  private logTx(sid: number | null, method: string, args: Record<string, unknown>, tx: TxResult, attempt: number, depositYocto: bigint): void {
    this.log.write({
      kind: 'tx',
      season_id: sid,
      method,
      args,
      tx_hash: tx.txHash,
      outcome: this.o.okOutcome,
      attempt,
      block: tx.block,
      deposit_yocto: String(depositYocto),
      signer: this.chain.signerId,
      ...(tx.keyIndex !== undefined ? { key: tx.keyIndex } : {}),
    });
  }

  /**
   * Send one tx with backoff. Before each retry `stillNeeded` re-reads chain
   * state; if the earlier attempt actually landed, we stop instead of re-sending.
   * `onOk` replaces the default ok record (the caller logs it itself, e.g. once the season id is known).
   */
  private async send(
    sid: number | null,
    method: string,
    args: Record<string, unknown>,
    depositYocto: bigint,
    stillNeeded: () => Promise<boolean>,
    onOk?: (tx: TxResult, attempt: number) => void,
  ): Promise<TxResult | null> {
    const res = await withRetry(
      async (attempt) => {
        const tx = await this.chain.call(method, args, { depositYocto, gas: this.o.gas ?? gasFor(method) });
        if (onOk) onOk(tx, attempt);
        else this.logTx(sid, method, args, tx, attempt, depositYocto);
        return tx;
      },
      {
        maxAttempts: this.o.maxAttempts,
        baseDelayMs: this.o.baseDelayMs,
        maxDelayMs: this.o.maxDelayMs,
        random: this.o.random,
        sleep: (ms) => this.chain.sleep(ms),
        onRetry: (attempt, err, delayMs) =>
          this.log.write({ kind: 'tx', season_id: sid, method, args, outcome: 'error', attempt, error: err.message, retry_in_ms: delayMs, tx_hash: err.txHash }),
      },
      async () => {
        const needed = await stillNeeded();
        if (!needed) this.log.write({ kind: 'tx', season_id: sid, method, args, outcome: 'skipped', msg: 'state changed since the failed attempt (it landed); not re-sending' });
        return needed;
      },
    );
    if (res.ok) return res.value;
    if (res.stopped) {
      this.result.skipped += 1;
      return null;
    }
    this.failure(sid, method, args, res.error, res.attempts);
    return null;
  }

  private failure(sid: number | null, method: string, args: Record<string, unknown>, err: ChainError, attempts: number): void {
    if (err.kind === 'refused') this.result.skipped += 1;
    else this.result.failed += 1;
    this.log.write({ kind: 'tx', season_id: sid, method, args, outcome: err.kind === 'refused' ? 'refused' : 'error', attempt: attempts, error: err.message, tx_hash: err.txHash, final: true });
  }

  private note(kind: 'phase' | 'info' | 'warn' | 'error', sid: number | null, msg: string): void {
    this.log.write({ kind, season_id: sid, msg });
  }

  /**
   * Timing milestone (once per season and name): `info/timing` with chain time and seconds since open.
   * Milestones: opened, pubkey, commits_sent, closed, scheduled, all_final, settled.
   */
  private async mark(sid: number, name: string): Promise<{ height: number; timestampNs: bigint }> {
    const head = await this.chain.head();
    const key = `${sid}:${name}`;
    if (this.marked.has(key)) return head;
    this.marked.add(key);
    const s = await this.chain.view<Season | null>('get_season', { season_id: sid });
    const since = s ? Number((head.timestampNs - BigInt(s.opened_at_ns)) / 1_000_000n) / 1000 : null;
    this.log.write({ kind: 'info', season_id: sid, msg: 'timing', mark: name, chain_ns: String(head.timestampNs), block: head.height, since_open_s: since });
    return head;
  }

  private async statusIs(sid: number, status: Season['status']): Promise<boolean> {
    const s = await this.chain.view<Season | null>('get_season', { season_id: sid });
    return s?.status === status;
  }

  private async matchStatusIn(m: Match, statuses: Match['status'][]): Promise<boolean> {
    const all = await this.allMatches(m.season_id);
    const now = all.find((x) => x.a === m.a && x.b === m.b);
    return now !== undefined && statuses.includes(now.status);
  }

  private async allMatches(sid: number): Promise<Match[]> {
    return fetchAll<Match>(this.chain, 'get_matches', { season_id: sid });
  }
}

const UNIT_NS = { s: 1_000_000_000n, m: 60_000_000_000n, h: 3_600_000_000_000n, d: 86_400_000_000_000n } as const;

/** "+90s" / "+2m" / "+1h" / "+1d" (or "90s", "2m") → milliseconds; null if not relative. */
export function parseDurationMs(x: string): number | null {
  const m = /^\+?(\d+)([smhd])$/.exec(x.trim());
  if (!m) return null;
  return Number((BigInt(m[1]) * UNIT_NS[m[2] as keyof typeof UNIT_NS]) / 1_000_000n);
}

/**
 * Absolute deadlines for open_season, computed from chain time `nowNs` right before sending:
 * - commit: `commitWindowMs` if given, else a relative `commit_deadline_ns` ("+2m"), is a window measured from pubkey
 *   arrival: deadline = now + pubkeyWaitMs + window. An absolute value is kept.
 * - play: a relative `play_deadline_ns` ("+15m") counts from now (open time). An absolute value is kept.
 */
export function resolveOpenParams(p: SeasonParams, nowNs: bigint, o: { pubkeyWaitMs: number; commitWindowMs?: number }): SeasonParams {
  const ms = (n: number): bigint => BigInt(Math.round(n)) * 1_000_000n;
  const window = o.commitWindowMs ?? parseDurationMs(p.commit_deadline_ns);
  const commit = window === null ? p.commit_deadline_ns : String(nowNs + ms(o.pubkeyWaitMs) + ms(window));
  const playRel = parseDurationMs(p.play_deadline_ns);
  const play = playRel === null ? p.play_deadline_ns : String(nowNs + ms(playRel));
  if (BigInt(play) <= BigInt(commit)) throw new Error(`play deadline (${play}) must be after the commit deadline (${commit})`);
  return { ...p, commit_deadline_ns: commit, play_deadline_ns: play };
}

export async function fetchAll<T>(chain: Pick<Chain, 'view'>, method: string, args: Record<string, unknown>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_LIMIT) {
    const page = await chain.view<T[]>(method, { ...args, from_index: from, limit: PAGE_LIMIT });
    out.push(...page);
    if (page.length < PAGE_LIMIT) return out;
  }
}

function countBy(xs: string[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const x of xs) o[x] = (o[x] ?? 0) + 1;
  return o;
}

