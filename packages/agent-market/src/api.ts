// Thin client for the NEAR Agent Market REST API (https://market.near.ai/openapi.json, v2.0.0).
// Only the endpoints this integration uses. Dry-run by default: a dry client records each request
// plan and never touches the network. Tokens never appear in plans, errors or logs.

export const DEFAULT_BASE_URL = 'https://market.near.ai';

/** Who a request authenticates as. `agent` = `aat_` agent token, `account` = a human owner's credential. */
export type Auth = 'none' | 'agent' | 'account';

export interface RequestPlan {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  auth: Auth;
  body?: unknown;
}

export interface DryRun {
  dryRun: true;
  plan: RequestPlan;
}

export const isDryRun = (x: unknown): x is DryRun =>
  typeof x === 'object' && x !== null && (x as DryRun).dryRun === true;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class MarketApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly code: string | undefined,
    detail: string,
  ) {
    super(`${method} ${path} -> ${status}${code ? ` ${code}` : ''}: ${detail}`);
    this.name = 'MarketApiError';
  }
}

export interface MarketClientOptions {
  baseUrl?: string;
  /** `aat_…` agent API token (returned once by register, or minted by the owner). */
  agentToken?: string;
  /** Human owner's bearer credential; needed only for owner-only calls (competition). */
  accountToken?: string;
  /** false = real HTTP. Default true. */
  dryRun?: boolean;
  fetch?: FetchLike;
  /** Called with every plan, executed or not. */
  onPlan?: (p: RequestPlan) => void;
}

// ---- request/response shapes (subset of the OpenAPI schemas) --------------------------------

export type Category =
  | 'automation' | 'creative' | 'customer_support' | 'data' | 'dev_tools' | 'events' | 'finance'
  | 'legal_compliance' | 'marketing' | 'operations' | 'research' | 'sales' | 'travel' | 'other';

export interface RegisterRequest {
  handle: string;
  name: string;
  category: Category;
  email?: string | null;
  sla_seconds?: number | null;
}
export interface RegisterResponse {
  agentId: string;
  accountId: string;
  handle: string;
  apiToken: string;
  tokenPrefix: string;
}

export interface CreateCompetitionRequest {
  title: string;
  description: string;
  poolAmount: string;
  poolToken?: 'USDC';
  entriesCloseAt: string;
  tags?: string[];
  minBuilderVerification?: 'none' | 'verified' | 'identity_verified' | null;
  acceptanceWindowDays?: number | null;
}

export interface CreatePricingPlanRequest {
  model: 'per_call';
  price_amount: string;
  display_name?: string | null;
  description?: string | null;
  sla_seconds?: number | null;
}

export interface PatchAgentRequest {
  name?: string;
  description?: string;
  bio_markdown?: string;
  category?: Category;
  listing_status?: 'draft' | 'live' | 'paused';
}

export interface AssignmentRow {
  assignment: {
    assignmentId: string;
    jobId: string;
    status: string;
    startedAt: string | null;
    submittedAt: string | null;
    escrowAmount?: string;
    escrowToken?: string;
  };
  job: { jobId: string; title: string; description: string; tags?: string[]; jobKind?: string };
  latestMessage: { body: string; truncated?: boolean } | null;
}

export const HANDLE_RE = /^[a-z][a-z0-9-]{2,29}$/;

export function validateHandle(h: string): void {
  if (!HANDLE_RE.test(h) || h.endsWith('-') || h.slice(2, 4) === '--') {
    throw new Error(`invalid market handle "${h}": 3-30 chars, [a-z][a-z0-9-]*, no trailing "-", no "--" at 3-4`);
  }
}

export class MarketClient {
  readonly baseUrl: string;
  readonly dryRun: boolean;
  readonly #agentToken?: string;
  readonly #accountToken?: string;
  readonly #fetch: FetchLike;
  readonly #onPlan?: (p: RequestPlan) => void;

  constructor(o: MarketClientOptions = {}) {
    this.baseUrl = (o.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.dryRun = o.dryRun ?? true;
    this.#agentToken = o.agentToken;
    this.#accountToken = o.accountToken;
    this.#fetch = o.fetch ?? ((u, i) => fetch(u, i));
    this.#onPlan = o.onPlan;
  }

  async request<T>(plan: RequestPlan): Promise<T | DryRun> {
    this.#onPlan?.(plan);
    if (this.dryRun) return { dryRun: true, plan };
    const headers: Record<string, string> = { accept: 'application/json' };
    if (plan.auth !== 'none') {
      const tok = plan.auth === 'agent' ? this.#agentToken : this.#accountToken;
      if (!tok) {
        throw new Error(
          plan.auth === 'agent'
            ? `${plan.method} ${plan.path} needs an agent token (MARKET_AGENT_TOKEN or --token-file)`
            : `${plan.method} ${plan.path} needs a human account credential (MARKET_ACCOUNT_TOKEN)`,
        );
      }
      headers.authorization = `Bearer ${tok}`;
    }
    if (plan.body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.#fetch(`${this.baseUrl}${plan.path}`, {
      method: plan.method,
      headers,
      body: plan.body === undefined ? undefined : JSON.stringify(plan.body),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const e = (json ?? {}) as Record<string, unknown>;
      const inner = (typeof e.error === 'object' && e.error !== null ? e.error : e) as Record<string, unknown>;
      const code = typeof inner.code === 'string' ? inner.code : typeof e.error === 'string' ? e.error : undefined;
      const msg = typeof inner.message === 'string' ? inner.message : text.slice(0, 300) || res.statusText;
      throw new MarketApiError(res.status, plan.method, plan.path, code, this.#redact(msg));
    }
    return json as T;
  }

  #redact(s: string): string {
    let out = s.replace(/\b(aat|wk|mcpbs|whsec)_[A-Za-z0-9]+/g, '$1_[redacted]');
    for (const t of [this.#agentToken, this.#accountToken]) if (t) out = out.split(t).join('[redacted]');
    return out;
  }

  // ---- public reads --------------------------------------------------------------------------
  platformStats() {
    return this.request<Record<string, number>>({ method: 'GET', path: '/v1/platform/stats', auth: 'none' });
  }
  platformConfig() {
    return this.request<Record<string, unknown>>({ method: 'GET', path: '/v1/platform/config', auth: 'none' });
  }
  browseAgents(q?: { q?: string; limit?: number }) {
    return this.request<{ agents: unknown[] }>({ method: 'GET', path: `/v1/agents${qs(q)}`, auth: 'none' });
  }

  // ---- agent (aat_) --------------------------------------------------------------------------
  /** Anonymous self-registration. Free; returns the only copy of the agent token. */
  register(body: RegisterRequest) {
    validateHandle(body.handle);
    return this.request<RegisterResponse>({ method: 'POST', path: '/v1/agents/register', auth: 'none', body });
  }
  createPricingPlan(agentId: string, body: CreatePricingPlanRequest) {
    return this.request<{ pricing_plan_id?: string; id?: string }>({
      method: 'POST', path: `/v1/agents/${enc(agentId)}/pricing-plans`, auth: 'agent', body,
    });
  }
  patchAgent(agentId: string, body: PatchAgentRequest) {
    return this.request<unknown>({ method: 'PATCH', path: `/v1/agents/${enc(agentId)}`, auth: 'agent', body });
  }
  adoptionCode() {
    return this.request<{ code: string; adoptionUrl: string; expiresAt: string }>({
      method: 'POST', path: '/v1/agents/me/adoption-code', auth: 'agent',
    });
  }
  jobBoard(q?: { q?: string; kind?: 'standard' | 'competition'; limit?: number }) {
    return this.request<{ jobs: unknown[] }>({ method: 'GET', path: `/v1/jobs/board${qs(q)}`, auth: 'agent' });
  }
  myAssignments() {
    return this.request<{ assignments: AssignmentRow[] }>({ method: 'GET', path: '/v1/agents/me/assignments', auth: 'agent' });
  }
  startAssignment(id: string) {
    return this.request<unknown>({ method: 'POST', path: `/v1/assignments/${enc(id)}/start`, auth: 'agent' });
  }
  message(id: string, body: string) {
    return this.request<unknown>({
      method: 'POST', path: `/v1/assignments/${enc(id)}/messages`, auth: 'agent', body: { body: body.slice(0, 4000) },
    });
  }
  submit(id: string, deliverableMarkdown: string) {
    return this.request<unknown>({
      method: 'POST', path: `/v1/assignments/${enc(id)}/submit`, auth: 'agent', body: { deliverableMarkdown },
    });
  }
  enterCompetition(jobId: string) {
    return this.request<unknown>({ method: 'POST', path: `/v1/jobs/${enc(jobId)}/entries`, auth: 'agent', body: {} });
  }

  // ---- human owner (spends USDC on mainnet) -------------------------------------------------
  createCompetition(body: CreateCompetitionRequest) {
    return this.request<{ jobId?: string; job?: { jobId: string } }>({
      method: 'POST', path: '/v1/jobs/competition', auth: 'account', body,
    });
  }
}

const enc = encodeURIComponent;

function qs(q?: Record<string, string | number | undefined>): string {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
