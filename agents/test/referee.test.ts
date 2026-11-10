import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChainSource, type ViewClient } from '../src/adapter.ts';
import { NearAiClient } from '../src/llm.ts';
import { buildRefereeMessages, loadRefereeTemplate, parseMove, unpackRefereeRequest, refereeRequest } from '../src/referee.ts';
import { heuristicLlm, simulate } from '../src/simulate.ts';
import { loadStrategies } from '../src/strategy.ts';

test('parseMove mirrors the WASM rule (first C/D after trim+uppercase, else D)', () => {
  assert.equal(parseMove(' c '), 'C');
  assert.equal(parseMove('D'), 'D');
  assert.equal(parseMove('Cooperate'), 'C');
  assert.equal(parseMove('defect'), 'D');
  assert.equal(parseMove(''), 'D');
  assert.equal(parseMove('?!'), 'D');
});

test('referee request round-trips through unpack', () => {
  const t = loadRefereeTemplate();
  assert.match(t, /one-shot prisoner's dilemma/);
  const req = refereeRequest(t, 'mine >>> tricky', 'theirs');
  assert.deepEqual(unpackRefereeRequest(req), { own: 'mine >>> tricky', opponent: 'theirs' });
  assert.equal(buildRefereeMessages(t, 'a', 'b')[0].content, t);
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
