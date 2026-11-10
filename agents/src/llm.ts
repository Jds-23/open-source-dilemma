// OpenAI-compatible chat client for NEAR AI Cloud, plus a mock. Never logs the API key.
import { existsSync, readFileSync } from 'node:fs';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  seed?: number;
  /** Qwen3-style switch; sent as chat_template_kwargs.enable_thinking (same as the referee WASM). */
  enable_thinking?: boolean;
}

export interface LlmClient {
  readonly label: string;
  chat(req: ChatRequest): Promise<string>;
}

export interface NearAiConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class NearAiClient implements LlmClient {
  readonly label: string;
  calls = 0;
  readonly #cfg: NearAiConfig;
  constructor(cfg: NearAiConfig) {
    this.#cfg = cfg;
    this.label = `nearai:${cfg.model}`;
  }
  static fromEnv(env: NodeJS.ProcessEnv = process.env): NearAiClient {
    const { NEARAI_BASE_URL, NEARAI_MODEL, NEARAI_API_KEY } = env;
    if (!NEARAI_BASE_URL || !NEARAI_MODEL || !NEARAI_API_KEY) {
      throw new Error('NEARAI_BASE_URL, NEARAI_MODEL and NEARAI_API_KEY must be set (or use the mock LLM)');
    }
    return new NearAiClient({ baseUrl: NEARAI_BASE_URL, model: NEARAI_MODEL, apiKey: NEARAI_API_KEY });
  }
  get model(): string {
    return this.#cfg.model;
  }
  async chat(req: ChatRequest): Promise<string> {
    const f = this.#cfg.fetch ?? fetch;
    const body: Record<string, unknown> = {
      model: this.#cfg.model,
      messages: req.messages,
      temperature: req.temperature ?? 0,
      max_tokens: req.max_tokens ?? 1024,
    };
    if (req.seed !== undefined) body.seed = req.seed;
    if (req.enable_thinking !== undefined) body.chat_template_kwargs = { enable_thinking: req.enable_thinking };
    this.calls++;
    const res = await f(`${this.#cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#cfg.timeoutMs ?? 60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`NEAR AI HTTP ${res.status}: ${text.slice(0, 200).replaceAll(this.#cfg.apiKey, '***')}`);
    const json = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? '';
  }
}

/** Deterministic mock: a handler maps the request to a reply. Records every request. */
export class MockLlm implements LlmClient {
  readonly label = 'mock';
  readonly requests: ChatRequest[] = [];
  private readonly handler: (req: ChatRequest, n: number) => string;
  constructor(handler: (req: ChatRequest, n: number) => string) {
    this.handler = handler;
  }
  async chat(req: ChatRequest): Promise<string> {
    this.requests.push(req);
    return this.handler(req, this.requests.length - 1);
  }
}

/** Load only NEARAI_* keys from a dotenv file into process.env (values never printed). Returns key names loaded. */
export function loadNearAiEnv(path: string): string[] {
  if (!existsSync(path)) return [];
  const loaded: string[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*(NEARAI_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    loaded.push(m[1]);
  }
  return loaded;
}
