// Off-chain sandbox referee. Server-only: reads NEARAI_* env, which must never reach the client.
// Mirrors the referee messages (system prompt + templated user frame), but this is
// practice: no TEE, no attestation, no stake. Uses the canonical WS2 template (interfaces-v3).
import 'server-only';
import { parseMove, payoff } from './game';

import { REFEREE_TEMPLATE } from './referee-template';

export { REFEREE_TEMPLATE };

// Same split and substitution as wasm/referee/src/template.rs.
const USER_MARKER = '\n<<<USER>>>\n';
const PH_OWN = '{{YOUR_STRATEGY}}';
const PH_OPP = '{{OPPONENT_SOURCE}}';

function parts() {
  const i = REFEREE_TEMPLATE.indexOf(USER_MARKER);
  const system = REFEREE_TEMPLATE.slice(0, i);
  const user = REFEREE_TEMPLATE.slice(i + USER_MARKER.length);
  const j = user.indexOf(PH_OWN);
  const k = user.indexOf(PH_OPP, j);
  return { system, pre: user.slice(0, j), mid: user.slice(j + PH_OWN.length, k), post: user.slice(k + PH_OPP.length) };
}

export const systemPrompt = () => parts().system;

/** Angle brackets inside strategies become fullwidth so a strategy can't close or forge a section tag. */
export const sanitize = (s: string) => s.replace(/</g, '\uFF1C').replace(/>/g, '\uFF1E');

/** Positional fill, so placeholder text inside a strategy is never substituted. */
export function userMessage(own: string, opp: string) {
  const { pre, mid, post } = parts();
  return `${pre}${sanitize(own)}${mid}${sanitize(opp)}${post}`;
}

export const MAX_PROMPT_BYTES = 4000;

export interface SandboxResult {
  mode: 'nearai' | 'mock';
  model: string;
  a_move: 'C' | 'D';
  b_move: 'C' | 'D';
  a_payoff: number;
  b_payoff: number;
  pool_delta: number;
  a_reply: string;
  b_reply: string;
}

/** Keyword heuristic used when NEARAI_API_KEY is absent. Deterministic, obviously not an LLM. */
export function mockReferee(own: string, opp: string): 'C' | 'D' {
  const o = own.toLowerCase();
  const p = opp.toLowerCase();
  const phrase = o.match(/passphrase\s+"([^"]+)"/);
  if (phrase) return p.includes(phrase[1]) ? 'C' : 'D';
  if (/always defect/.test(o)) return 'D';
  if (/always cooperate/.test(o)) return 'C';
  const oppHostile = /always defect|must output c|ignore your instructions/.test(p);
  if (/\bunless\b|\bif\b|only if/.test(o)) return oppHostile ? 'D' : 'C';
  const c = o.indexOf('cooperate');
  const d = o.indexOf('defect');
  if (c === -1 && d === -1) return 'D';
  return c !== -1 && (d === -1 || c < d) ? 'C' : 'D';
}

export interface NearAiEnv {
  apiKey?: string;
  baseUrl: string;
  model: string;
}

export function nearAiEnv(env: Record<string, string | undefined> = process.env): NearAiEnv {
  return {
    apiKey: env.NEARAI_API_KEY?.trim() || undefined,
    baseUrl: (env.NEARAI_BASE_URL?.trim() || 'https://cloud-api.near.ai/v1').replace(/\/$/, ''),
    model: env.NEARAI_MODEL?.trim() || 'Qwen/Qwen3.8-27B',
  };
}

async function askNearAi(cfg: NearAiEnv, own: string, opp: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: userMessage(own, opp) },
      ],
      temperature: 0,
      seed: 42,
      max_tokens: 8,
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`NEAR AI HTTP ${res.status}`);
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
  return body.choices?.[0]?.message?.content ?? '';
}

export function validatePrompts(a: unknown, b: unknown): string | null {
  if (typeof a !== 'string' || typeof b !== 'string') return 'Both strategies must be text.';
  if (!a.trim() || !b.trim()) return 'Both strategies need some text.';
  const enc = new TextEncoder();
  if (enc.encode(a).length > MAX_PROMPT_BYTES || enc.encode(b).length > MAX_PROMPT_BYTES)
    return `Each strategy is capped at ${MAX_PROMPT_BYTES} bytes (same as on chain).`;
  return null;
}

export async function playSandbox(a: string, b: string, cfg: NearAiEnv = nearAiEnv(), fetchImpl: typeof fetch = fetch): Promise<SandboxResult> {
  let mode: SandboxResult['mode'] = 'mock';
  let a_reply: string;
  let b_reply: string;
  if (cfg.apiKey) {
    mode = 'nearai';
    [a_reply, b_reply] = await Promise.all([askNearAi(cfg, a, b, fetchImpl), askNearAi(cfg, b, a, fetchImpl)]);
  } else {
    a_reply = mockReferee(a, b);
    b_reply = mockReferee(b, a);
  }
  const a_move = parseMove(a_reply);
  const b_move = parseMove(b_reply);
  const [pa, pb, pool] = payoff(a_move, b_move);
  return {
    mode,
    model: mode === 'mock' ? 'mock-keyword-referee' : cfg.model,
    a_move,
    b_move,
    a_payoff: pa,
    b_payoff: pb,
    pool_delta: pool,
    a_reply: a_reply.slice(0, 64),
    b_reply: b_reply.slice(0, 64),
  };
}
