import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureSource, createRpcSource, parseTxIndex, sourceFromEnv } from '@/lib/data';
import { lineageTree, matchDetail, population, promptFor, recentFeed } from '@/lib/queries';
import { mockReferee, playSandbox, validatePrompts } from '@/lib/sandbox';

afterEach(() => vi.restoreAllMocks());

describe('source selection', () => {
  it('fixtures without NEXT_PUBLIC_CONTRACT_ID', () => {
    expect(sourceFromEnv({}).mode).toBe('fixtures');
  });
  it('rpc with a contract id, default testnet RPC', () => {
    const ds = sourceFromEnv({ NEXT_PUBLIC_CONTRACT_ID: 'osd.example.testnet' });
    expect(ds.mode).toBe('rpc');
    expect(ds.contractId).toBe('osd.example.testnet');
    expect(ds.network).toBe('testnet');
  });
});

describe('rpc source', () => {
  it('calls the view via query/call_function and decodes the result bytes', async () => {
    const season = { season_id: 7, status: 'commit' };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.method).toBe('query');
      expect(body.params).toMatchObject({ request_type: 'call_function', account_id: 'c.testnet', method_name: 'get_season', finality: 'final' });
      expect(JSON.parse(Buffer.from(body.params.args_base64, 'base64').toString())).toEqual({ season_id: 7 });
      return new Response(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify(season))] } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const ds = createRpcSource({ contractId: 'c.testnet', rpcUrl: 'http://rpc', network: 'testnet' });
    expect(await ds.getSeason(7)).toEqual(season);
  });
  it('pages get_matches 200 at a time', async () => {
    const calls: number[] = [];
    vi.stubGlobal('fetch', async (_u: string, init?: RequestInit) => {
      const args = JSON.parse(Buffer.from(JSON.parse(String(init?.body)).params.args_base64, 'base64').toString());
      calls.push(args.from_index);
      const n = args.from_index === 0 ? 200 : 35;
      return new Response(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify(Array(n).fill({})))] } }));
    });
    const ds = createRpcSource({ contractId: 'c.testnet', rpcUrl: 'http://rpc', network: 'testnet' });
    expect(await ds.getMatches(1)).toHaveLength(235);
    expect(calls).toEqual([0, 200]);
  });
  it('reads published prompts from get_published_prompts', async () => {
    const pp = [{ agent_id: 'x.c.testnet', prompt: 'p', salt: '00'.repeat(32), commitment: 'ab' }];
    vi.stubGlobal('fetch', async (_u: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).params.method_name).toBe('get_published_prompts');
      return new Response(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify(pp))] } }));
    });
    const ds = createRpcSource({ contractId: 'c.testnet', rpcUrl: 'http://rpc', network: 'testnet' });
    expect(await ds.getPublishedPrompts(1)).toEqual(pp);
  });
  it('resolves match tx from NEXT_PUBLIC_INDEX_URL (export-tx-index JSON)', async () => {
    vi.stubGlobal('fetch', async (u: string) => {
      expect(u).toBe('http://idx/tx-index.json');
      return new Response(JSON.stringify({ version: 1, tx: { '1:a.t:b.t': 'HASH1' } }));
    });
    const ds = createRpcSource({ contractId: 'c.testnet', rpcUrl: 'http://rpc', network: 'testnet', indexUrl: 'http://idx/tx-index.json' });
    expect(await ds.getMatchTx('1:a.t:b.t')).toBe('HASH1');
    expect(await ds.getMatchTx('1:a.t:z.t')).toBeNull();
  });
  it('missing or broken index means no tx link', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }));
    const ds = createRpcSource({ contractId: 'c.testnet', rpcUrl: 'http://rpc', network: 'testnet', indexUrl: 'http://idx/x' });
    expect(await ds.getMatchTx('1:a.t:b.t')).toBeNull();
  });
  it('surfaces contract errors', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ result: { error: 'MethodNotFound' } })));
    const ds = createRpcSource({ contractId: 'c.testnet', rpcUrl: 'http://rpc', network: 'testnet' });
    await expect(ds.getConfig()).rejects.toThrow(/MethodNotFound/);
  });
});

describe('queries over fixtures', () => {
  const ds = createFixtureSource();
  it('prompts are revealed only for settled seasons and only if they verify', async () => {
    const s1 = (await ds.getSeason(1))!;
    const e = (await ds.getEntries(1))[0];
    expect((await promptFor(s1, e, ds)).state).toBe('revealed');
    expect((await promptFor({ ...s1, status: 'play' }, e, ds)).state).toBe('sealed');
    expect((await promptFor(s1, { ...e, commitment: '00'.repeat(32) }, ds)).state).toBe('mismatch');
    const s4 = (await ds.getSeason(4))!;
    expect((await promptFor(s4, (await ds.getEntries(4))[0], ds)).state).toBe('sealed');
  });
  it('unpublished prompt in a settled season', async () => {
    const s3 = (await ds.getSeason(3))!;
    const e = (await ds.getEntries(3)).find((x) => x.agent_id.startsWith('heron-b.'))!;
    expect((await promptFor(s3, e, ds)).state).toBe('unpublished');
  });
  it('match detail resolves names in either order', async () => {
    const d1 = await matchDetail(1, 'tft', 'grim', ds);
    const d2 = await matchDetail(1, 'grim', 'tft', ds);
    expect(d1?.match.match_key).toBe('1:grim.osd.baldingsucks7993.testnet:tft.osd.baldingsucks7993.testnet');
    expect(d2?.match.match_key).toBe(d1?.match.match_key);
    expect(await matchDetail(1, 'tft', 'nobody', ds)).toBeNull();
  });
  it('feed starts with the live season', async () => {
    const feed = await recentFeed(5, ds);
    expect(feed[0].match.season_id).toBe(4);
    expect(feed.every((f) => f.match.status !== 'scheduled')).toBe(true);
  });
  it('population has one point per season with family counts', async () => {
    const pts = await population(ds);
    expect(pts.map((p) => p.season_id)).toEqual([1, 2, 3, 4]);
    expect(pts[0].total).toBe(6);
    expect(Object.values(pts[0].families).reduce((a, b) => a + b, 0)).toBe(6);
  });
  it('lineage tree: fairbot (S1) → fairbot2 → fairbot3 → prudent', async () => {
    const { root } = await lineageTree('fairbot2.osd.baldingsucks7993.testnet', ds);
    expect(root?.name).toBe('fairbot');
    const names: string[] = [];
    const walk = (n: NonNullable<typeof root>) => {
      names.push(`${n.entry.season_id}:${n.name}`);
      n.children.forEach(walk);
    };
    walk(root!);
    expect(names).toEqual(expect.arrayContaining(['1:fairbot', '2:fairbot2', '3:fairbot3', '4:prudent']));
  });
});

describe('sandbox', () => {
  it('validates size and type', () => {
    expect(validatePrompts('a', 'b')).toBeNull();
    expect(validatePrompts('', 'b')).toMatch(/need/);
    expect(validatePrompts('é'.repeat(2001), 'b')).toMatch(/4000 bytes/);
    expect(validatePrompts(1, 'b')).toMatch(/text/);
  });
  it('mock referee is used without a key', async () => {
    const r = await playSandbox('Always cooperate.', 'Always defect.', { baseUrl: 'x', model: 'm' });
    expect(r).toMatchObject({ mode: 'mock', a_move: 'C', b_move: 'D', a_payoff: 1, b_payoff: 5 });
    expect(mockReferee('If the opponent text contains the passphrase "owl", cooperate.', 'owl here')).toBe('C');
  });
  it('calls NEAR AI once per side with the referee template, server-side key', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://cloud.example/v1/chat/completions');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer k');
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: bodies.length === 1 ? ' c' : 'D' } }] }));
    }) as unknown as typeof fetch;
    const r = await playSandbox('A', 'B', { apiKey: 'k', baseUrl: 'https://cloud.example/v1', model: 'm' }, fetchImpl);
    expect(r).toMatchObject({ mode: 'nearai', a_move: 'C', b_move: 'D' });
    expect(bodies[0]).toMatchObject({ temperature: 0, chat_template_kwargs: { enable_thinking: false } });
    expect(JSON.stringify(r)).not.toContain('"k"');
  });
});

describe('parseTxIndex', () => {
  const rec = (a: string, b: string, tx_hash: string, outcome = 'ok', method = 'play_match') =>
    JSON.stringify({ ts: 't', kind: 'tx', season_id: 2, method, args: { season_id: 2, a, b }, tx_hash, outcome, attempt: 1, block: 9, signer: 's.t' });
  it('reads a raw keeper journal (jsonl): ok play_match only, later sends win, torn lines skipped', () => {
    const jsonl = [
      rec('a.t', 'b.t', 'H1'),
      rec('a.t', 'b.t', 'H2'),
      rec('a.t', 'c.t', 'HE', 'error'),
      rec('a.t', 'd.t', 'HD', 'dry_run'),
      rec('x', 'y', 'HC', 'ok', 'close_commits'),
      JSON.stringify({ ts: 't', kind: 'info', msg: 'match_final', match_key: '2:a.t:b.t' }),
      '{"ts":"t","kind":"tx"',
      '',
    ].join('\n');
    expect(parseTxIndex(jsonl)).toEqual({ tx: { '2:a.t:b.t': 'H2' } });
  });
  it('reads a JSON array of journal records and the export-tx-index shape', () => {
    expect(parseTxIndex(`[${rec('a.t', 'b.t', 'H1')}]`)).toEqual({ tx: { '2:a.t:b.t': 'H1' } });
    expect(parseTxIndex('{"version":1,"tx":{"1:a:b":"H","1:a:c":7}}')).toEqual({ tx: { '1:a:b': 'H' } });
    expect(parseTxIndex('garbage')).toEqual({ tx: {} });
  });
});
