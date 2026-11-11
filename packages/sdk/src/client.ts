// Typed client over every public method/view in interfaces/contract-abi.json.
import {
  AGENT_KEY_METHODS,
  DEFAULT_GAS,
  FAMILY_RE,
  MIN_OUTLAYER_DEPOSIT,
  MIN_REGISTER_DEPOSIT,
  ONE_YOCTO,
  MAX_SEAL_KEYS,
  PAGE_MAX,
  SEAL_CONFIRM,
  SECRETS_PROFILE_RE,
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
  PromptRecord,
  PublishedPrompt,
  Season,
  SeasonParams,
  ViewArgs,
  ViewMethod,
  ViewReturns,
} from './types.js';

/**
 * Optional off-chain source of published prompts (indexer / web export). The default source is the
 * on-chain `get_published_prompts` view; a PromptSource is only used as a fallback when that view fails
 * (e.g. a contract deployed before interfaces-v3).
 */
export interface PromptSource {
  list(filter?: { seasonId?: number; agentId?: string }): Promise<PromptRecord[]>;
}

/** Static list (fixtures, tests). */
export function staticPromptSource(prompts: PromptRecord[]): PromptSource {
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
      return staticPromptSource((await r.json()) as PromptRecord[]).list(f);
    },
  };
}

export interface OsdClientOptions {
  contractId: string;
  provider: ViewProvider;
  /** Needed for calls. Use `agentKeySigner` for commit/claim, `fullAccessSigner` for owner actions. */
  signer?: TxSigner;
  /** Fallback for `getPublishedPrompts` when the `get_published_prompts` view fails. */
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

export interface VerifiedPrompt extends PromptRecord {
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

  /** v5 seal flag. A sealed contract also has `view_access_key_list == []` (check both). */
  isSealed(): Promise<boolean> {
    return this.view('is_sealed', {});
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

  /** One page of `get_published_prompts` (publish order; only prompts revealed via `publish_prompt`). */
  getPublishedPromptsPage(seasonId: number, page: { fromIndex?: number; limit?: number } = {}): Promise<PublishedPrompt[]> {
    return this.view('get_published_prompts', { season_id: seasonId, ...pageArgs(page) });
  }

  /** Every published prompt of a season (follows pagination). */
  getAllPublishedPrompts(seasonId: number): Promise<PublishedPrompt[]> {
    return paginate((fromIndex, limit) => this.getPublishedPromptsPage(seasonId, { fromIndex, limit }));
  }

  /**
   * Published prompts joined with season + family and checked against the on-chain entry commitment.
   * Reads `get_published_prompts` (all seasons up to `current_season_id` when `seasonId` is omitted);
   * falls back to the configured PromptSource if the view fails. Unverified prompts are returned
   * with `verified: false`, never silently dropped.
   */
  async getPublishedPrompts(filter: { seasonId?: number; agentId?: string } = {}): Promise<VerifiedPrompt[]> {
    let list: PromptRecord[];
    try {
      list = await this.#chainPrompts(filter);
    } catch (err) {
      if (!this.prompts) throw err;
      list = await this.prompts.list(filter);
    }
    const bySeason = new Map<number, Entry[]>();
    const out: VerifiedPrompt[] = [];
    for (const p of list) {
      if (!bySeason.has(p.season_id)) bySeason.set(p.season_id, await this.getAllEntries(p.season_id));
      const e = bySeason.get(p.season_id)!.find((x) => x.agent_id === p.agent_id);
      out.push({ ...p, family: p.family || e?.family || '', verified: !!e && verifyCommitment(p.prompt, p.salt, p.agent_id, e.commitment) });
    }
    return out;
  }

  async #chainPrompts(f: { seasonId?: number; agentId?: string }): Promise<PromptRecord[]> {
    let seasons: number[];
    if (f.seasonId !== undefined) seasons = [f.seasonId];
    else {
      const cur = (await this.getConfig()).current_season_id;
      seasons = cur === null ? [] : Array.from({ length: cur }, (_, i) => i + 1);
    }
    const out: PromptRecord[] = [];
    for (const season_id of seasons) {
      for (const p of await this.getAllPublishedPrompts(season_id)) {
        if (f.agentId !== undefined && p.agent_id !== f.agentId) continue;
        // family is filled from the entry in getPublishedPrompts
        out.push({ season_id, agent_id: p.agent_id, family: '', prompt: p.prompt, salt: p.salt, published: true });
      }
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

  /** Owner: open a season, optionally pinning a different referee (`wasmUrl` + `wasmHash` together) or secrets profile. */
  async openSeason(
    params: SeasonParams,
    depositYocto: bigint = MIN_OUTLAYER_DEPOSIT,
    gas?: bigint,
    overrides: { wasmUrl?: string; wasmHash?: string; secretsProfile?: string } = {},
  ) {
    if ((overrides.wasmUrl === undefined) !== (overrides.wasmHash === undefined)) throw new Error('wasmUrl and wasmHash must be overridden together');
    const args: CallArgs['open_season'] = { params };
    if (overrides.wasmUrl !== undefined) Object.assign(args, { wasm_url: overrides.wasmUrl, wasm_hash: overrides.wasmHash });
    if (overrides.secretsProfile !== undefined) args.secrets_profile = overrides.secretsProfile;
    return this.call('open_season', args, { deposit: depositYocto, gas });
  }

  /**
   * Owner, ONE WAY (v5): delete every listed access key of the contract account and set the seal flag.
   * Pass the complete `view_access_key_list`; `confirm` must be the literal `SEAL-FOREVER`.
   */
  async seal(publicKeys: string[], confirm: typeof SEAL_CONFIRM, gas?: bigint) {
    if (confirm !== SEAL_CONFIRM) throw new Error(`confirm must be ${JSON.stringify(SEAL_CONFIRM)}`);
    if (publicKeys.length > MAX_SEAL_KEYS) throw new Error(`at most ${MAX_SEAL_KEYS} keys`);
    if (new Set(publicKeys).size !== publicKeys.length) throw new Error('duplicate key');
    return this.call('seal', { public_keys: publicKeys, confirm }, { deposit: ONE_YOCTO, gas });
  }

  /**
   * Owner, before seal only (v6): point seasons opened from now on at the OutLayer secrets row `owner/profile`.
   * Use a profile stored by the contract account itself so it is immutable once sealed.
   */
  async setSecrets(owner: string, profile: string, gas?: bigint) {
    if (!SECRETS_PROFILE_RE.test(profile)) throw new Error(`invalid profile ${JSON.stringify(profile)} (want ${SECRETS_PROFILE_RE})`);
    return this.call('set_secrets', { owner, profile }, { deposit: ONE_YOCTO, gas });
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

  /** One `settle_season` call: `[]` means a void batch ran and more calls are needed (see `settleSeasonFully`). */
  async settleSeason(seasonId: number, gas?: bigint) {
    return this.call('settle_season', { season_id: seasonId }, { gas });
  }

  /**
   * Call `settle_season` until the season is settled (non-empty ranking, or status `settled` when nobody ranked).
   * After the play deadline each call voids ≤ 40 unfinished matches and returns `[]` (40 agents: up to 20 calls).
   */
  async settleSeasonFully(seasonId: number, o: { maxCalls?: number; gas?: bigint } = {}): Promise<LeaderboardRow[]> {
    const maxCalls = o.maxCalls ?? 32;
    for (let i = 0; i < maxCalls; i++) {
      const out = await this.settleSeason(seasonId, o.gas);
      if (Array.isArray(out.value) && out.value.length > 0) return out.value;
      if ((await this.getSeason(seasonId))?.status === 'settled') return this.view('get_leaderboard', { season_id: seasonId });
    }
    throw new Error(`settle_season: season ${seasonId} not settled after ${maxCalls} calls`);
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
