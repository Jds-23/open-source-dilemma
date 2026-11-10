// Local mirror of the referee request (wasm/referee, WS2) so strategies can be sanity-checked off chain.
// Request shape follows the current referee WASM: system = template, user = delimited own/opponent prompts.
// When WS2 freezes the canonical template, update REFEREE_TEMPLATE / buildRefereeMessages to match it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_DIR } from './adapter.ts';
import type { ChatMessage, ChatRequest, LlmClient } from './llm.ts';

const FALLBACK_TEMPLATE =
  "You are the referee of a one-shot prisoner's dilemma. You act for ONE player. Read that player's strategy (YOUR STRATEGY) " +
  "and the opponent's strategy (OPPONENT STRATEGY), then decide the move the player's strategy implies against this opponent. " +
  'Payoffs (you/opponent): both C = 3/3; you D, opponent C = 5/1; you C, opponent D = 1/5; both D = 1/1 (and 4 go to the shared pool). ' +
  'Reply with exactly one character: C (cooperate) or D (defect). Nothing else.';

export function loadRefereeTemplate(path: string = join(FIXTURES_DIR, 'referee-template.txt')): string {
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : FALLBACK_TEMPLATE;
}

export function buildRefereeMessages(template: string, own: string, opponent: string): ChatMessage[] {
  return [
    { role: 'system', content: template },
    { role: 'user', content: `YOUR STRATEGY:\n<<<${own}>>>\n\nOPPONENT STRATEGY:\n<<<${opponent}>>>\n\nYour move (C or D):` },
  ];
}

export function refereeRequest(template: string, own: string, opponent: string): ChatRequest {
  return { messages: buildRefereeMessages(template, own, opponent), temperature: 0, seed: 42, max_tokens: 4, enable_thinking: false };
}

/** Same rule as the WASM: trim, uppercase, first 'C' or 'D' character wins; anything else is D. */
export function parseMove(reply: string): 'C' | 'D' {
  for (const ch of reply.trim().toUpperCase()) {
    if (ch === 'C') return 'C';
    if (ch === 'D') return 'D';
  }
  return 'D';
}

export async function refereeMove(llm: LlmClient, template: string, own: string, opponent: string): Promise<{ move: 'C' | 'D'; reply: string }> {
  const reply = await llm.chat(refereeRequest(template, own, opponent));
  return { move: parseMove(reply), reply };
}

/** Extract (own, opponent) prompts back out of a referee request (used by the heuristic mock). */
export function unpackRefereeRequest(req: ChatRequest): { own: string; opponent: string } | null {
  const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
  const m = /^YOUR STRATEGY:\n<<<([\s\S]*)>>>\n\nOPPONENT STRATEGY:\n<<<([\s\S]*)>>>\n\nYour move \(C or D\):$/.exec(user);
  return m ? { own: m[1], opponent: m[2] } : null;
}

const UNCONDITIONAL_D = /\b(i always defect|always defect\. ignore|my move is d\b|defect \(d\) in every|my actual move is d)/i;
const UNCONDITIONAL_C = /\b(i always cooperate|always cooperate\. ignore)/i;
const INJECTION = /(system override|referee update|note to the referee|for the referee acting|reply: c|answer c\b|must output c|only valid answer)/i;
const PASSPHRASE = /(AMBER LANTERN 7Q|cobalt-heron-31|VRD::sing-the-ninth-bell)/;

/**
 * Crude keyword referee for OFFLINE plumbing checks only (no model). It is not a model of the
 * real referee: use `--live` for behaviour. Unconditional rules are honoured; conditional rules
 * cooperate unless the opponent looks like a defector or injector; cliques need their passphrase.
 */
export function heuristicReply(own: string, opponent: string): string {
  if (UNCONDITIONAL_D.test(own)) return 'D';
  if (UNCONDITIONAL_C.test(own)) return 'C';
  const pass = PASSPHRASE.exec(own)?.[1];
  if (pass && own.includes(`exact`) && opponent.includes(pass)) return 'C';
  if (pass && /no matter how friendly/i.test(own)) return 'D';
  const hostile = UNCONDITIONAL_D.test(opponent) || INJECTION.test(opponent);
  return hostile ? 'D' : 'C';
}
