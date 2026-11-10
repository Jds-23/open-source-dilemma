// Local mirror of the referee request (wasm/referee, WS2) so strategies can be sanity-checked off chain.
// Mirrors wasm/referee/src/template.rs + llm.rs at interfaces-v3: the canonical template file is
// `<system>\n<<<USER>>>\n<user frame>`; the user frame holds {{YOUR_STRATEGY}} and {{OPPONENT_SOURCE}}
// (substituted positionally, after `<`/`>` in both strategies become fullwidth ＜/＞).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './strategy.ts';
import type { ChatMessage, ChatRequest, LlmClient } from './llm.ts';

/** Canonical template (compiled into the WASM byte-exact). */
export const REFEREE_TEMPLATE_PATH = join(REPO_ROOT, 'wasm', 'referee', 'referee-template.txt');
/** `referee_template_hash` frozen in interfaces-v3 (INTERFACE.md §9.2). */
export const REFEREE_TEMPLATE_HASH = '556bce7073d6cd3d62a798e36b36b1eda1c61c3b448be58fc928b0e2b614f865';

const USER_MARKER = '\n<<<USER>>>\n';
const PH_OWN = '{{YOUR_STRATEGY}}';
const PH_OPP = '{{OPPONENT_SOURCE}}';

/** Read the template byte-exact (no trim: the hash covers the whole file). */
export function loadRefereeTemplate(path: string = REFEREE_TEMPLATE_PATH): string {
  return readFileSync(path, 'utf8');
}

export function templateHash(template: string): string {
  return createHash('sha256').update(template, 'utf8').digest('hex');
}

function parts(template: string): { system: string; pre: string; mid: string; post: string } {
  const i = template.indexOf(USER_MARKER);
  if (i < 0) throw new Error('referee template: missing <<<USER>>> marker');
  const system = template.slice(0, i);
  const user = template.slice(i + USER_MARKER.length);
  const j = user.indexOf(PH_OWN);
  const k = user.indexOf(PH_OPP, j + PH_OWN.length);
  if (j < 0 || k < 0) throw new Error('referee template: missing placeholders');
  return { system, pre: user.slice(0, j), mid: user.slice(j + PH_OWN.length, k), post: user.slice(k + PH_OPP.length) };
}

/** Same as the WASM: angle brackets inside strategies become fullwidth so they cannot forge section tags. */
export function sanitize(s: string): string {
  return s.replaceAll('<', '\uFF1C').replaceAll('>', '\uFF1E');
}

export function buildRefereeMessages(template: string, own: string, opponent: string): ChatMessage[] {
  const { system, pre, mid, post } = parts(template);
  return [
    { role: 'system', content: system },
    { role: 'user', content: pre + sanitize(own) + mid + sanitize(opponent) + post },
  ];
}

/** Season params as in the fixtures (`wasm-inputs.json`): temperature 0, seed 42, max_tokens 4, thinking off. */
export function refereeRequest(template: string, own: string, opponent: string): ChatRequest {
  return { messages: buildRefereeMessages(template, own, opponent), temperature: 0, seed: 42, max_tokens: 4, enable_thinking: false };
}

/**
 * Strict WASM parser (INTERFACE.md §8): trim + uppercase, the first character must be C or D,
 * anything else is D. `flagged` (the WASM's `nonstrict` log flag) unless the reply is one letter
 * (optionally followed by `.`). A leading empty `<think></think>` block is ignored.
 */
export function parseMoveStrict(reply: string): { move: 'C' | 'D'; flagged: boolean } {
  let t = reply.trim();
  const th = /^<think>([\s\S]*?)<\/think>/.exec(t);
  if (th && th[1].trim() === '') t = t.slice(th[0].length).trim();
  const up = t.toUpperCase();
  const c = up[0];
  if (c !== 'C' && c !== 'D') return { move: 'D', flagged: true };
  return { move: c, flagged: !(up.length === 1 || up === 'C.' || up === 'D.') };
}

export function parseMove(reply: string): 'C' | 'D' {
  return parseMoveStrict(reply).move;
}

export async function refereeMove(llm: LlmClient, template: string, own: string, opponent: string): Promise<{ move: 'C' | 'D'; reply: string }> {
  const reply = await llm.chat(refereeRequest(template, own, opponent));
  return { move: parseMove(reply), reply };
}

/** Extract the (sanitised) own/opponent prompts back out of a referee request (used by the heuristic mock). */
export function unpackRefereeRequest(req: ChatRequest): { own: string; opponent: string } | null {
  const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
  const m = /<YOUR_STRATEGY>\n([\s\S]*)\n<\/YOUR_STRATEGY>\n\n<OPPONENT_SOURCE>\n([\s\S]*)\n<\/OPPONENT_SOURCE>\n\nYour move \(C or D\):$/.exec(user);
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
