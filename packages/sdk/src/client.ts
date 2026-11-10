// Typed client over every public method/view in interfaces/contract-abi.json.
import {
  AGENT_KEY_METHODS,
  DEFAULT_GAS,
  FAMILY_RE,
  MIN_OUTLAYER_DEPOSIT,
  MIN_REGISTER_DEPOSIT,
  ONE_YOCTO,
  PAGE_MAX,
  agentAccountId,
  orderPair,
} from './constants.js';
import { sealPrompt, verifyCommitment, type SaltInput } from './crypto.js';
import type { CallOptions, CallOutcome, TxSigner, ViewProvider } from './transport.js';
import type {
  Agent,
  CallArgs,
  CallMethod,
  CallReturns,
  Config,
  Entry,
  LeaderboardRow,
  LineageEntry,
  Match,
  MatchKey,
  MatchStatus,
  Parent,
  PublishedPrompt,
  Season,
  SeasonParams,
  ViewArgs,
  ViewMethod,
  ViewReturns,
} from './types.js';

/** Where published prompts come from. On chain they live only in `publish_prompt` tx args, so an indexer is needed. */
export interface PromptSource {
  list(filter?: { seasonId?: number; agentId?: string }): Promise<PublishedPrompt[]>;
}

/** Static list (fixtures, tests). */
export function staticPromptSource(prompts: PublishedPrompt[]): PromptSource {
  return {
    async list(f = {}) {
      return prompts.filter(
        (p) => p.published !== false && (f.seasonId === undefined || p.season_id === f.seasonId) && (f.agentId === undefined || p.agent_id === f.agentId),
      );
    },
  };
}

/** Fetch a JSON array shaped like `fixtures/prompts.json` from `url` (e.g. an indexer or the web app's export). */
export function httpPromptSource(url: string, fetchImpl: typeof fetch = fetch): PromptSource {
  return {
    async list(f = {}) {
      const r = await fetchImpl(url);
      if (!r.ok) throw new Error(`prompt index ${url}: HTTP ${r.status}`);
      return staticPromptSource((await r.json()) as PublishedPrompt[]).list(f);
    },
  };
}

export interface OsdClientOptions {
  contractId: string;
  provider: ViewProvider;
  /** Needed for calls. Use `agentKeySigner` for commit/claim, `fullAccessSigner` for owner actions. */
  signer?: TxSigner;
  prompts?: PromptSource;
}

export interface SealAndCommitInput {
  agentId: string;
  prompt: string;
  family: string;
  parent?: Parent;
  /** Defaults to `get_config().current_season_id`. */
  seasonId?: number;
  /** Defaults to a fresh random salt. */
  salt?: SaltInput;
  gas?: bigint;
}

export interface SealAndCommitResult {
  seasonId: number;
  agentId: string;
  commitment: string;
  /** Keep secret until settlement; needed for `publishPrompt`. */
  salt: string;
  ciphertextHex: string;
  outcome: CallOutcome<null>;
}

export interface VerifiedPrompt extends PublishedPrompt {
  /** `commitment(prompt, salt, agent_id)` equals the on-chain entry's commitment. */
  verified: boolean;
}

export class OsdClient {
  readonly contractId: string;
  readonly provider: ViewProvider;
  readonly signer?: TxSigner;
  readonly prompts?: PromptSource;

  constructor(o: OsdClientOptions) {
    this.contractId = o.contractId;
    this.provider = o.provider;
    this.signer = o.signer;
    this.prompts = o.prompts;
  }

  /** Same client, different signer. */
  withSigner(signer: TxSigner): OsdClient {
    return new OsdClient({ contractId: this.contractId, provider: this.provider, signer, prompts: this.prompts });
  }

  /** `<name>.<contract>` */
  agentId(name: string): string {
    return agentAccountId(name, this.contractId);
  }

  // ------------------------------------------------------------------ raw typed access

  async view<M extends ViewMethod>(method: M, args: ViewArgs[M]): Promise<ViewReturns[M]> {
    return (await this.provider.view(this.contractId, method, args)) as ViewReturns[M];
  }

  async call<M extends CallMethod>(method: M, args: CallArgs[M], opts: CallOptions = {}): Promise<CallOutcome<CallReturns[M]>> {
    if (!this.signer) throw new Error(`${method} needs a signer (none configured)`);
    const out = await this.signer.call(this.contractId, method, args, {
      gas: opts.gas ?? DEFAULT_GAS[method],
      deposit: opts.deposit ?? 0n,
    });
    return out as CallOutcome<CallReturns[M]>;
  }

  // ------------------------------------------------------------------ views (§6.2)

  getConfig(): Promise<Config> {
    return this.view('get_config', {});
  }

  getSeason(seasonId: number): Promise<Season | null> {
    return this.view('get_season', { season_id: seasonId });
  }

  /** Current season (from `get_config().current_season_id`), or null if none was opened. */
  async getCurrentSeason(): Promise<Season | null> {
    const id = (await this.getConfig()).current_season_id;
    return id === null ? null : this.getSeason(id);
  }

  getSeasonPubkey(seasonId: number): Promise<string | null> {
    return this.view('get_season_pubkey', { season_id: seasonId });
  }

  getEntries(seasonId: number, page: { fromIndex?: number; limit?: number } = {}): Promise<Entry[]> {
    return this.view('get_entries', { season_id: seasonId, ...pageArgs(page) });
  }

  getMatches(seasonId: number, o: { fromIndex?: number; limit?: number; status?: MatchStatus } = {}): Promise<Match[]> {
    return this.view('get_matches', { season_id: seasonId, ...pageArgs(o), ...(o.status ? { status: o.status } : {}) });
  }

  /** Every entry of a season (follows pagination). */
  getAllEntries(seasonId: number): Promise<Entry[]> {
    return paginate((fromIndex, limit) => this.getEntries(seasonId, { fromIndex, limit }));
  }

  /** Every match of a season (follows pagination). */
  getAllMatches(seasonId: number, status?: MatchStatus): Promise<Match[]> {
    return paginate((fromIndex, limit) => this.getMatches(seasonId, { fromIndex, limit, status }));
  }

  /** Match results of a season, optionally only those involving `agentId`. */
  async getResults(seasonId: number, agentId?: string): Promise<Match[]> {
    const all = await this.getAllMatches(seasonId);
    return agentId ? all.filter((m) => m.a === agentId || m.b === agentId) : all;
  }

  getLeaderboard(seasonId: number): Promise<LeaderboardRow[]> {
    return this.view('get_leaderboard', { season_id: seasonId });
  }

  getAgent(agentId: string): Promise<Agent | null> {
    return this.view('get_agent', { agent_id: agentId });
  }

  getLineage(agentId: string): Promise<LineageEntry[]> {
    return this.view('get_lineage', { agent_id: agentId });
  }

  /** Walk `parent` links from `(seasonId, agentId)` back to the root. First element is the starting entry. */
  async getAncestry(seasonId: number, agentId: string, maxDepth = 64): Promise<LineageEntry[]> {
    const out: LineageEntry[] = [];
    let cur: Parent = { season_id: seasonId, agent_id: agentId };
    const seen = new Set<string>();
    while (cur && out.length < maxDepth) {
      const key = `${cur.season_id}:${cur.agent_id}`;
      if (seen.has(key)) break;
      seen.add(key);
      const season_id: number = cur.season_id;
      const hit: LineageEntry | undefined = (await this.getLineage(cur.agent_id)).find((l) => l.season_id === season_id);
      if (!hit) break;
      out.push(hit);
      cur = hit.parent;
    }
    return out;
  }

  getClaimable(seasonId: number, agentId: string): Promise<string> {
    return this.view('get_claimable', { season_id: seasonId, agent_id: agentId });
  }

  /**
   * Published prompts (needs a PromptSource), each checked against the on-chain entry commitment.
   * Unverified prompts are returned with `verified: false`, never silently dropped.
   */
  async getPublishedPrompts(filter: { seasonId?: number; agentId?: string } = {}): Promise<VerifiedPrompt[]> {
    if (!this.prompts) throw new Error('no prompt source configured (published prompts are only in publish_prompt tx args)');
    const list = await this.prompts.list(filter);
    const bySeason = new Map<number, Entry[]>();
    const out: VerifiedPrompt[] = [];
    for (const p of list) {
      if (!bySeason.has(p.season_id)) bySeason.set(p.season_id, await this.getAllEntries(p.season_id));
      const e = bySeason.get(p.season_id)!.find((x) => x.agent_id === p.agent_id);
      out.push({ ...p, verified: !!e && verifyCommitment(p.prompt, p.salt, p.agent_id, e.commitment) });
    }
    return out;
  }

  // ------------------------------------------------------------------ calls (§6.1)

  /** Owner: create `<name>.<contract>` with FC key `agentPublicKey` scoped to commit/claim. Deposit ≥ 0.25 NEAR (0.2 funds the account). */
  async registerAgent(i: { name: string; agentPublicKey: string; depositYocto?: bigint; gas?: bigint }) {
    const deposit = i.depositYocto ?? MIN_REGISTER_DEPOSIT;
    if (deposit < MIN_REGISTER_DEPOSIT) throw new Error('register_agent needs at least 0.25 NEAR');
    agentAccountId(i.name, this.contractId); // validates the name
    return this.call('register_agent', { name: i.name, agent_public_key: i.agentPublicKey }, { deposit, gas: i.gas });
  }

  /** Anyone: add `depositYocto` to the agent's budget. */
  async fundAgent(agentId: string, depositYocto: bigint, gas?: bigint) {
    if (depositYocto <= 0n) throw new Error('fund_agent needs a positive deposit');
    return this.call('fund_agent', { agent_id: agentId }, { deposit: depositYocto, gas });
  }

  /** Owner: withdraw from the agent budget (attaches 1 yocto). */
  async withdraw(agentId: string, amountYocto: bigint | string, gas?: bigint) {
    return this.call('withdraw', { agent_id: agentId, amount_yocto: String(amountYocto) }, { deposit: ONE_YOCTO, gas });
  }

  /** Raw commit (you sealed the prompt yourself). Prefer `sealAndCommit`. */
  async commit(args: CallArgs['commit'], gas?: bigint) {
    if (!FAMILY_RE.test(args.family)) throw new Error(`family must match ${FAMILY_RE}`);
    return this.call('commit', args, { gas });
  }

  /**
   * Fetch the season pubkey, seal `prompt` with a fresh salt bound to `agentId`, and `commit`.
   * Returns the salt: persist it (needed for `publishPrompt`), don't publish it before settlement.
   */
  async sealAndCommit(i: SealAndCommitInput): Promise<SealAndCommitResult> {
    const seasonId = i.seasonId ?? (await this.getConfig()).current_season_id;
    if (seasonId === null || seasonId === undefined) throw new Error('no current season');
    const season = await this.getSeason(seasonId);
    if (!season) throw new Error(`season ${seasonId} not found`);
    if (season.status !== 'commit') throw new Error(`season ${seasonId} is ${season.status}, not accepting commits`);
    const pubkey = await this.getSeasonPubkey(seasonId);
    if (!pubkey) throw new Error(`season ${seasonId} has no pubkey yet`);
    const sealed = sealPrompt(pubkey, i.prompt, i.agentId, i.salt);
    const outcome = await this.commit(
      {
        season_id: seasonId,
        agent_id: i.agentId,
        ciphertext_hex: sealed.ciphertext_hex,
        commitment: sealed.commitment,
        family: i.family,
        parent: i.parent ?? null,
      },
      i.gas,
    );
    return { seasonId, agentId: i.agentId, commitment: sealed.commitment, salt: sealed.salt, ciphertextHex: sealed.ciphertext_hex, outcome };
  }

  /** Agent or owner: move the season's claimable into the agent budget. */
  async claim(seasonId: number, agentId: string, gas?: bigint) {
    return this.call('claim', { season_id: seasonId, agent_id: agentId }, { gas });
  }

  /** Owner, after settlement: reveal the prompt (checked against the commitment on chain). */
  async publishPrompt(i: { seasonId: number; agentId: string; prompt: string; salt: string; gas?: bigint }) {
    return this.call('publish_prompt', { season_id: i.seasonId, agent_id: i.agentId, prompt: i.prompt, salt: i.salt }, { gas: i.gas });
  }

  // keeper / contract-owner calls

  async openSeason(params: SeasonParams, depositYocto: bigint = MIN_OUTLAYER_DEPOSIT, gas?: bigint) {
    return this.call('open_season', { params }, { deposit: depositYocto, gas });
  }

  async closeCommits(seasonId: number, gas?: bigint) {
    return this.call('close_commits', { season_id: seasonId }, { gas });
  }

  async scheduleRound(seasonId: number, gas?: bigint) {
    return this.call('schedule_round', { season_id: seasonId }, { gas });
  }

  /** Keeper: one-shot match execution (OutLayer). `a`/`b` are ordered for you. */
  async playMatch(key: MatchKey, depositYocto: bigint = MIN_OUTLAYER_DEPOSIT, gas?: bigint) {
    return this.call('play_match', orderKey(key), { deposit: depositYocto, gas });
  }

  async refundVoid(key: MatchKey, gas?: bigint) {
    return this.call('refund_void', orderKey(key), { gas });
  }

  async settleSeason(seasonId: number, gas?: bigint) {
    return this.call('settle_season', { season_id: seasonId }, { gas });
  }

  /** Can the configured signer call `method`? (agent FC keys: commit/claim only) */
  canCall(method: CallMethod): boolean {
    if (!this.signer) return false;
    return this.signer.kind === 'full_access' || AGENT_KEY_METHODS.includes(method);
  }
}

function orderKey(k: MatchKey): MatchKey {
  const [a, b] = orderPair(k.a, k.b);
  return { season_id: k.season_id, a, b };
}

function pageArgs(p: { fromIndex?: number; limit?: number }): { from_index?: number; limit?: number } {
  return {
    ...(p.fromIndex !== undefined ? { from_index: p.fromIndex } : {}),
    ...(p.limit !== undefined ? { limit: p.limit } : {}),
  };
}

async function paginate<T>(fetchPage: (fromIndex: number, limit: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (;;) {
    const page = await fetchPage(out.length, PAGE_MAX);
    out.push(...page);
    if (page.length < PAGE_MAX) return out;
  }
}
