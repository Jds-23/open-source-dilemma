// Fixture-backed in-memory mock of the dilemma contract, so consumers (WS4 evolver, WS5 web, MCP)
// can run fully offline. Views mirror INTERFACE.md §6.2 (interfaces-v3); calls for the player/owner flow
// (register_agent, fund_agent, withdraw, open_season, commit, claim, publish_prompt) are simulated
// with the contract's refusal rules. Keeper calls (close_commits, schedule_round, play_match,
// refund_void, settle_season) are not simulated and throw.
import {
  AGENT_ACCOUNT_FUNDING,
  AGENT_NAME_RE,
  CONTRACT_TESTNET,
  FAMILY_RE,
  MAX_CIPHERTEXT_HEX,
  MIN_OUTLAYER_DEPOSIT,
  MIN_REGISTER_DEPOSIT,
  ONE_YOCTO,
  PAGE_DEFAULT,
  PAGE_MAX,
  STAKE_UNITS_PER_MATCH,
} from './constants.js';
import { verifyCommitment } from './crypto.js';
import { formatEventLog, parseEventLogs, type OsdEventData, type OsdEventName } from './events.js';
import { scopeToAgentKey, type CallOutcome, type KeyKind, type TxSigner, type ViewProvider } from './transport.js';
import type {
  Agent,
  CallArgs,
  Config,
  Entry,
  LeaderboardRow,
  LineageEntry,
  Match,
  PublishedPrompt,
  Season,
  SeasonParams,
} from './types.js';

/** TEST-ONLY season pubkey from `interfaces/fixtures/test-key-vector.json` (public half only). */
export const TEST_ONLY_SEASON_PUBKEY = '0360e153bf8c4758cda4f312a2cc3da490d6593ee843475888337ee944b3ec8cf4';

/** The JSON files in `interfaces/fixtures/`, parsed. */
export interface Fixtures {
  season: Season | Season[];
  agents: Agent[];
  entries: Entry[];
  matches: Match[];
  /** Leaderboard of the fixture season (or a map season_id -> rows). */
  leaderboard: LeaderboardRow[] | Record<number, LeaderboardRow[]>;
  lineage: LineageEntry[];
  /** `get_config` (`config.json`). */
  config: Config;
  /** `published-prompts.json` (rows of the fixture season, or a map season_id -> rows). */
  publishedPrompts?: PublishedPrompt[] | Record<number, PublishedPrompt[]>;
  /** `claimable.json`; seasons without rows here get claimable computed by the §6.1 formula. */
  claimable?: ClaimableFixture[];
  /** Raw `EVENT_JSON:` lines (`events.jsonl`). */
  events?: string[];
}

/** A row of `fixtures/claimable.json` (the view returns only `claimable_yocto`). */
export interface ClaimableFixture {
  season_id: number;
  agent_id: string;
  claimable_yocto: string;
  breakdown?: Record<string, string>;
  forfeited?: boolean;
}

export class MockContractError extends Error {
  override name = 'MockContractError';
}

export interface MockChainOptions {
  contractId?: string;
  /** Clock for deadlines, ns. Defaults to wall clock. */
  nowNs?: () => bigint;
}

const clone = <T>(v: T): T => structuredClone(v);
const fail = (msg: string): never => {
  throw new MockContractError(msg);
};
const page = <T>(xs: T[], from = 0, limit = PAGE_DEFAULT): T[] => xs.slice(from, from + Math.min(Math.max(limit, 0), PAGE_MAX));

export class MockChain implements ViewProvider {
  readonly contractId: string;
  readonly config: Config;
  readonly seasons = new Map<number, Season>();
  readonly agents = new Map<string, Agent>();
  readonly entries: Entry[] = [];
  readonly matches: Match[] = [];
  readonly leaderboards = new Map<number, LeaderboardRow[]>();
  readonly lineage: LineageEntry[] = [];
  /** season_id -> published prompts, publish order. */
  readonly prompts = new Map<number, PublishedPrompt[]>();
  /** Event log lines, fixture stream first, then everything the mock emits. */
  readonly eventLog: string[] = [];
  readonly #claimable = new Map<string, bigint>();
  readonly #now: () => bigint;
  #tx = 0;

  constructor(fx: Fixtures, opts: MockChainOptions = {}) {
    this.contractId = opts.contractId ?? CONTRACT_TESTNET;
    this.#now = opts.nowNs ?? (() => BigInt(Date.now()) * 1_000_000n);
    const seasons = Array.isArray(fx.season) ? fx.season : [fx.season];
    for (const s of seasons) this.seasons.set(s.season_id, clone(s));
    for (const a of fx.agents) this.agents.set(a.agent_id, clone(a));
    this.entries.push(...clone(fx.entries));
    this.matches.push(...clone(fx.matches));
    this.lineage.push(...clone(fx.lineage));
    this.eventLog.push(...(fx.events ?? []));
    if (Array.isArray(fx.leaderboard)) {
      const sid = seasons[0]?.season_id;
      if (sid !== undefined) this.leaderboards.set(sid, clone(fx.leaderboard));
    } else for (const [k, v] of Object.entries(fx.leaderboard)) this.leaderboards.set(Number(k), clone(v));
    const pp = fx.publishedPrompts ?? [];
    if (Array.isArray(pp)) {
      const sid = seasons[0]?.season_id;
      if (sid !== undefined && pp.length) this.prompts.set(sid, clone(pp));
    } else for (const [k, v] of Object.entries(pp)) this.prompts.set(Number(k), clone(v));
    this.config = clone(fx.config);
    for (const s of this.seasons.values()) {
      if (s.status === 'settled') for (const [id, amt] of this.computeClaimable(s.season_id)) this.#claimable.set(`${s.season_id}:${id}`, amt);
    }
    for (const c of fx.claimable ?? []) this.#claimable.set(`${c.season_id}:${c.agent_id}`, BigInt(c.claimable_yocto));
  }

  // ---------- views ----------

  async view(contractId: string, method: string, args: object): Promise<unknown> {
    if (contractId !== this.contractId) fail(`MockChain serves ${this.contractId}, not ${contractId}`);
    return clone(this.viewSync(method, args as Record<string, unknown>));
  }

  viewSync(method: string, a: Record<string, unknown>): unknown {
    const sid = a.season_id as number;
    const from = a.from_index as number | undefined;
    const limit = a.limit as number | undefined;
    switch (method) {
      case 'get_config':
        return this.config;
      case 'get_season':
        return this.seasons.get(sid) ?? null;
      case 'get_season_pubkey':
        return this.seasons.get(sid)?.pubkey ?? null;
      case 'get_entries':
        return page(this.entries.filter((e) => e.season_id === sid), from, limit);
      case 'get_matches':
        return page(
          this.matches.filter((m) => m.season_id === sid && (a.status === undefined || m.status === a.status)),
          from,
          limit,
        );
      case 'get_leaderboard':
        return this.leaderboards.get(sid) ?? this.#liveLeaderboard(sid);
      case 'get_agent':
        return this.agents.get(a.agent_id as string) ?? null;
      case 'get_lineage':
        return this.lineage.filter((l) => l.agent_id === a.agent_id).sort((x, y) => x.season_id - y.season_id);
      case 'get_claimable':
        return String(this.#claimable.get(`${sid}:${a.agent_id as string}`) ?? 0n);
      case 'get_published_prompts':
        return page(this.prompts.get(sid) ?? [], from, limit);
      default:
        return fail(`MethodNotFound: ${method}`);
    }
  }

  // ---------- signers ----------

  /** A signer acting as `accountId`. `function_call` applies the agent-key scope (commit/claim, no deposit). */
  signer(accountId: string, kind: KeyKind = 'full_access'): TxSigner {
    const base: TxSigner = {
      accountId,
      kind: 'full_access',
      call: async (cid, method, args, opts) => {
        if (cid !== this.contractId) fail(`MockChain serves ${this.contractId}, not ${cid}`);
        return this.#exec(accountId, method, clone(args) as Record<string, unknown>, opts.deposit);
      },
    };
    return kind === 'function_call' ? scopeToAgentKey(base, this.contractId) : base;
  }

  /** Test helper: open a new season straight into `commit` status (skips the OutLayer key round trip). */
  openSeason(params: Partial<SeasonParams> = {}, pubkey: string = TEST_ONLY_SEASON_PUBKEY): Season {
    const prev = this.seasons.get(this.config.current_season_id ?? -1);
    const now = this.#now();
    const p: SeasonParams = {
      commit_deadline_ns: String(now + 86_400n * 1_000_000_000n),
      play_deadline_ns: String(now + 2n * 86_400n * 1_000_000_000n),
      unit_yocto: '10000000000000000000000',
      bond_yocto: '50000000000000000000000',
      max_agents: 40,
      max_entries_per_owner: 3,
      referee_template_hash: prev?.params.referee_template_hash ?? '0'.repeat(64),
      model: prev?.params.model ?? 'Qwen/Qwen3.8-27B',
      prize_split_bps: [5000, 3000, 2000],
      ...params,
    };
    const season_id = Math.max(0, ...this.seasons.keys()) + 1;
    const entry = BigInt(p.bond_yocto) + BigInt(STAKE_UNITS_PER_MATCH) * BigInt(p.unit_yocto) * BigInt(p.max_agents - 1);
    const s: Season = {
      season_id,
      status: 'commit',
      params: p,
      wasm: prev?.wasm ?? { url: this.config.wasm_url, hash: this.config.wasm_hash },
      pubkey,
      entry_deposit_yocto: String(entry),
      stake_per_agent_yocto: null,
      n_entries: 0,
      total_rounds: 0,
      rounds_scheduled: 0,
      n_matches: 0,
      n_settled: 0,
      n_void: 0,
      pool_yocto: '0',
      opened_at_ns: String(now),
      closed_at_ns: null,
      settled_at_ns: null,
    };
    this.seasons.set(season_id, s);
    this.config.current_season_id = season_id;
    this.#emit('season_opened', {
      season_id,
      pubkey,
      referee_template_hash: p.referee_template_hash,
      commit_deadline_ns: p.commit_deadline_ns,
      entry_deposit_yocto: s.entry_deposit_yocto,
    });
    return clone(s);
  }

  // ---------- internals ----------

  #pending: string[] = [];
  #emit<K extends OsdEventName>(event: K, data: OsdEventData[K]): void {
    const line = formatEventLog(event, data);
    this.eventLog.push(line);
    this.#pending.push(line);
  }

  #liveLeaderboard(sid: number): LeaderboardRow[] {
    return this.entries
      .filter((e) => e.season_id === sid)
      .map((e) => ({
        agent_id: e.agent_id,
        owner: e.owner,
        family: e.family,
        matches_counted: 0,
        total_payoff_counted: 0,
        avg_payoff_milli: 0,
        rank: null,
        prize_yocto: '0',
      }));
  }

  /**
   * INTERFACE.md §6.1 claimable formula for a settled season, per agent:
   * unused stake + payoffs + 3 units per void match + prize + bond (withheld if the agent forfeited a match).
   * Matches `fixtures/claimable.json`.
   */
  computeClaimable(seasonId: number): Map<string, bigint> {
    const s = this.#season(seasonId);
    const res = new Map<string, bigint>();
    const unit = BigInt(s.params.unit_yocto);
    const bond = BigInt(s.params.bond_yocto);
    const excess = BigInt(s.entry_deposit_yocto) - bond - BigInt(s.stake_per_agent_yocto ?? 0);
    const board = this.leaderboards.get(s.season_id) ?? [];
    for (const e of this.entries.filter((x) => x.season_id === s.season_id)) {
      const id = e.agent_id;
      let units = 0n;
      let forfeited = false;
      for (const m of this.matches.filter((x) => x.season_id === s.season_id && (x.a === id || x.b === id))) {
        const isA = m.a === id;
        if (m.status === 'settled') {
          units += BigInt(isA ? m.a_payoff : m.b_payoff);
          if ((isA ? m.a_move : m.b_move) === 'F') forfeited = true;
        } else if (m.status === 'void' || m.status === 'refunded') units += BigInt(STAKE_UNITS_PER_MATCH);
      }
      const prize = BigInt(board.find((r) => r.agent_id === id)?.prize_yocto ?? 0);
      res.set(id, excess + units * unit + prize + (forfeited ? 0n : bond));
    }
    return res;
  }

  #agent(id: string): Agent {
    return this.agents.get(id) ?? fail(`unknown agent ${id}`);
  }

  #season(id: number): Season {
    return this.seasons.get(id) ?? fail(`unknown season ${id}`);
  }

  async #exec(caller: string, method: string, a: Record<string, unknown>, deposit: bigint): Promise<CallOutcome> {
    this.#pending = [];
    const value = this.#run(caller, method, a, deposit);
    const logs = this.#pending;
    this.#pending = [];
    return { txHash: `mock-tx-${++this.#tx}`, value, logs, events: parseEventLogs(logs) };
  }

  #run(caller: string, method: string, a: Record<string, unknown>, deposit: bigint): unknown {
    switch (method) {
      case 'register_agent': {
        const { name, agent_public_key } = a as CallArgs['register_agent'];
        if (deposit < MIN_REGISTER_DEPOSIT) fail('deposit below 0.25 NEAR');
        if (!AGENT_NAME_RE.test(name)) fail(`invalid name ${name}`);
        if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(agent_public_key)) fail('bad agent_public_key');
        const agent_id = `${name}.${this.contractId}`;
        if (this.agents.has(agent_id)) fail(`name taken: ${name}`);
        this.agents.set(agent_id, {
          agent_id,
          name,
          owner: caller,
          registered_at_ns: String(this.#now()),
          budget_yocto: String(deposit - AGENT_ACCOUNT_FUNDING),
          seasons: [],
        });
        this.#emit('agent_registered', { agent_id, owner: caller, name });
        return agent_id;
      }
      case 'fund_agent': {
        const ag = this.#agent((a as CallArgs['fund_agent']).agent_id);
        if (deposit <= 0n) fail('deposit must be > 0');
        ag.budget_yocto = String(BigInt(ag.budget_yocto) + deposit);
        return ag.budget_yocto;
      }
      case 'withdraw': {
        const { agent_id, amount_yocto } = a as CallArgs['withdraw'];
        const ag = this.#agent(agent_id);
        if (deposit !== ONE_YOCTO) fail('requires exactly 1 yocto');
        if (caller !== ag.owner) fail('not owner');
        if (BigInt(amount_yocto) > BigInt(ag.budget_yocto)) fail('amount > budget');
        ag.budget_yocto = String(BigInt(ag.budget_yocto) - BigInt(amount_yocto));
        return ag.budget_yocto;
      }
      case 'open_season': {
        if (caller !== this.config.owner) fail('only the contract owner');
        if (deposit < MIN_OUTLAYER_DEPOSIT) fail('deposit below 0.02 NEAR');
        const prev = this.seasons.get(this.config.current_season_id ?? -1);
        if (prev && prev.status !== 'settled' && prev.status !== 'cancelled') fail('previous season not finished');
        const { params } = a as CallArgs['open_season'];
        if (params.prize_split_bps.reduce((x, y) => x + y, 0) !== 10000) fail('prize_split_bps must sum to 10000');
        return this.openSeason(params).season_id;
      }
      case 'commit': {
        const c = a as unknown as CallArgs['commit'];
        const s = this.#season(c.season_id);
        const ag = this.#agent(c.agent_id);
        if (caller !== ag.agent_id && caller !== ag.owner) fail('caller is neither the agent nor its owner');
        if (s.status !== 'commit') fail(`season ${s.season_id} status is ${s.status}, not commit`);
        if (this.#now() >= BigInt(s.params.commit_deadline_ns)) fail('past commit deadline');
        const inSeason = this.entries.filter((e) => e.season_id === s.season_id);
        if (inSeason.some((e) => e.agent_id === c.agent_id)) fail('agent already entered');
        if (inSeason.filter((e) => e.owner === ag.owner).length >= s.params.max_entries_per_owner) {
          fail('owner reached max_entries_per_owner');
        }
        if (inSeason.length >= s.params.max_agents) fail('max_agents reached');
        if (BigInt(ag.budget_yocto) < BigInt(s.entry_deposit_yocto)) fail('budget < entry_deposit_yocto');
        if (!/^[0-9a-f]+$/.test(c.ciphertext_hex) || c.ciphertext_hex.length % 2 || c.ciphertext_hex.length > MAX_CIPHERTEXT_HEX) {
          fail('bad ciphertext_hex');
        }
        if (!/^[0-9a-f]{64}$/.test(c.commitment)) fail('bad commitment');
        if (!FAMILY_RE.test(c.family)) fail(`bad family ${c.family}`);
        ag.budget_yocto = String(BigInt(ag.budget_yocto) - BigInt(s.entry_deposit_yocto));
        if (!ag.seasons.includes(s.season_id)) ag.seasons.push(s.season_id);
        this.entries.push({
          season_id: s.season_id,
          agent_id: c.agent_id,
          owner: ag.owner,
          family: c.family,
          parent: c.parent ?? null,
          commitment: c.commitment,
          ciphertext_hex: c.ciphertext_hex,
          committed_at_ns: String(this.#now()),
        });
        this.lineage.push({
          season_id: s.season_id,
          agent_id: c.agent_id,
          commitment: c.commitment,
          family: c.family,
          parent: c.parent ?? null,
          rank: null,
          avg_payoff_milli: null,
        });
        s.n_entries += 1;
        this.#emit('committed', {
          season_id: s.season_id,
          agent_id: c.agent_id,
          commitment: c.commitment,
          family: c.family,
          parent: c.parent ?? null,
        });
        return null;
      }
      case 'claim': {
        const { season_id, agent_id } = a as CallArgs['claim'];
        const ag = this.#agent(agent_id);
        if (caller !== ag.agent_id && caller !== ag.owner) fail('caller is neither the agent nor its owner');
        const k = `${season_id}:${agent_id}`;
        const amt = this.#claimable.get(k) ?? 0n;
        if (amt === 0n) fail('nothing claimable');
        this.#claimable.set(k, 0n);
        ag.budget_yocto = String(BigInt(ag.budget_yocto) + amt);
        return String(amt);
      }
      case 'publish_prompt': {
        const { season_id, agent_id, prompt, salt } = a as CallArgs['publish_prompt'];
        const ag = this.#agent(agent_id);
        if (caller !== ag.owner) fail('not owner');
        if (this.#season(season_id).status !== 'settled') fail('season not settled');
        const e = this.entries.find((x) => x.season_id === season_id && x.agent_id === agent_id) ?? fail('no entry');
        if (!/^[0-9a-f]{64}$/.test(salt) || !verifyCommitment(prompt, salt, agent_id, e.commitment)) fail('commitment mismatch');
        const list = this.prompts.get(season_id) ?? [];
        const rec: PublishedPrompt = { agent_id, prompt, salt, commitment: e.commitment };
        const i = list.findIndex((p) => p.agent_id === agent_id);
        if (i >= 0) list[i] = rec;
        else list.push(rec);
        this.prompts.set(season_id, list);
        this.#emit('prompt_published', { season_id, agent_id, commitment: e.commitment });
        return null;
      }
      case 'close_commits':
      case 'schedule_round':
      case 'play_match':
      case 'refund_void':
      case 'settle_season':
        return fail(`${method} is not simulated by MockChain`);
      default:
        return fail(`MethodNotFound: ${method}`);
    }
  }
}
