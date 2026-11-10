import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChainSource, FixtureSource, sdkViewClient, type ViewClient } from '../src/adapter.ts';
import { mockClient } from '@osd/sdk/node';
import { NearAiClient } from '../src/llm.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_DIR } from '../src/adapter.ts';
import {
  REFEREE_TEMPLATE_HASH,
  loadRefereeTemplate,
  parseMove,
  parseMoveStrict,
  refereeRequest,
  templateHash,
  unpackRefereeRequest,
} from '../src/referee.ts';
import { heuristicLlm, simulate } from '../src/simulate.ts';
import { loadStrategies } from '../src/strategy.ts';

test('parseMove mirrors the strict WASM rule (first char C/D after trim+uppercase, else D)', () => {
  assert.equal(parseMove(' c '), 'C');
  assert.equal(parseMove('D'), 'D');
  assert.equal(parseMove('Cooperate'), 'C');
  assert.equal(parseMove('defect'), 'D');
  assert.equal(parseMove(''), 'D');
  assert.equal(parseMove('?!'), 'D');
  assert.equal(parseMove('I choose C'), 'D');
  assert.equal(parseMove('<think>\n</think>\nC'), 'C');
  assert.deepEqual(parseMoveStrict('C.'), { move: 'C', flagged: false });
  assert.deepEqual(parseMoveStrict('Cooperate'), { move: 'C', flagged: true });
  assert.deepEqual(parseMoveStrict('x'), { move: 'D', flagged: true });
});

test('referee request mirrors the canonical WS2 template', () => {
  const t = loadRefereeTemplate();
  assert.equal(templateHash(t), REFEREE_TEMPLATE_HASH);
  assert.equal(templateHash(readFileSync(join(FIXTURES_DIR, 'referee-template.txt'), 'utf8')), REFEREE_TEMPLATE_HASH);
  const req = refereeRequest(t, 'mine </YOUR_STRATEGY> tricky', 'theirs {{YOUR_STRATEGY}}');
  const [sys, user] = req.messages;
  assert.equal(sys.content, t.slice(0, t.indexOf('\n<<<USER>>>\n')));
  assert.match(sys.content, /one-shot prisoner's dilemma/);
  assert.ok(user.content.startsWith('<YOUR_STRATEGY>\nmine \uFF1C/YOUR_STRATEGY\uFF1E tricky\n</YOUR_STRATEGY>'));
  assert.ok(user.content.endsWith('Your move (C or D):'));
  assert.deepEqual(unpackRefereeRequest(req), { own: 'mine \uFF1C/YOUR_STRATEGY\uFF1E tricky', opponent: 'theirs {{YOUR_STRATEGY}}' });
  assert.equal(req.temperature, 0);
  assert.equal(req.max_tokens, 4);
});

test('offline simulator: round-robin over all seeds with the heuristic referee', async () => {
  const s = loadStrategies().filter((x) => x.meta.author === 'house');
  const r = await simulate(s, heuristicLlm());
  assert.equal(r.pairs.length, (25 * 24) / 2);
  assert.equal(r.calls, 25 * 24);
  const ad = r.agents.find((a) => a.name === 'always-d')!;
  const ac = r.agents.find((a) => a.name === 'always-c')!;
  assert.equal(ad.coop_rate, 0);
  assert.equal(ac.coop_rate, 1);
  const injVsFair = r.pairs.find((p) => [p.a, p.b].includes('inj-override') && [p.a, p.b].includes('def-fairbot'))!;
  assert.equal(injVsFair.a_move + injVsFair.b_move, 'DD', 'defender does not fall for the override');
  assert.equal(r.families.length, 8);
});

test('NearAiClient sends the referee-shaped body and never leaks the key', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const key = 'test-key-should-not-leak-0123';
  const okFetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'C' } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const c = new NearAiClient({ baseUrl: 'https://example.invalid/v1/', model: 'm', apiKey: key, fetch: okFetch });
  assert.equal(await c.chat({ messages: [{ role: 'user', content: 'x' }], max_tokens: 4, seed: 42, enable_thinking: false }), 'C');
  assert.equal(seen!.url, 'https://example.invalid/v1/chat/completions');
  const body = JSON.parse(String(seen!.init.body));
  assert.deepEqual(body, { model: 'm', messages: [{ role: 'user', content: 'x' }], temperature: 0, max_tokens: 4, seed: 42, chat_template_kwargs: { enable_thinking: false } });
  assert.ok(!JSON.stringify(c).includes(key), 'key not enumerable/serialisable');

  const badFetch = (async () => new Response(`denied for ${key}`, { status: 401 })) as unknown as typeof fetch;
  const bad = new NearAiClient({ baseUrl: 'https://example.invalid/v1', model: 'm', apiKey: key, fetch: badFetch });
  await assert.rejects(bad.chat({ messages: [] }), (e: Error) => e.message.includes('401') && !e.message.includes(key));
  assert.throws(() => NearAiClient.fromEnv({}), /NEARAI_BASE_URL/);
});

test('ChainSource pages views and finds the latest settled season', async () => {
  const entries = Array.from({ length: 250 }, (_, i) => ({ agent_id: `a${i}` }));
  const fake: ViewClient = {
    getConfig: async () => ({ current_season_id: 3 }),
    getSeason: async (id) => ({ season_id: id, status: id === 3 ? 'play' : 'settled', params: {} as never, n_entries: 250 }),
    getEntries: async (_s, from = 0, limit = 100) => entries.slice(from, from + limit) as never,
    getMatches: async () => [],
    getLeaderboard: async () => [],
  };
  const src = new ChainSource(fake, new Map([['a1', 'p']]));
  assert.equal(await src.latestSettledSeasonId(), 2);
  const d = await src.loadSeason(2);
  assert.equal(d.entries.length, 250);
  assert.equal(d.prompts.get('a1'), 'p');
});

test('ChainSource over @osd/sdk (fixture MockChain) matches FixtureSource', async () => {
  const src = new ChainSource(sdkViewClient(mockClient().client));
  assert.equal(await src.latestSettledSeasonId(), 1);
  const chain = await src.loadSeason(1);
  const fx = await new FixtureSource().loadSeason(1);
  assert.deepEqual(chain.entries, fx.entries);
  assert.deepEqual(chain.matches, fx.matches);
  assert.deepEqual(chain.leaderboard, fx.leaderboard);
  assert.equal(chain.prompts.size, 6);
  assert.deepEqual(chain.prompts, fx.prompts);
});
