import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_GAS,
  MIN_OUTLAYER_DEPOSIT,
  OsdClient,
  RpcViewProvider,
  ScopeError,
  agentKeySigner,
  formatNear,
  generateAgentKey,
  matchKeyString,
  parseNear,
  publicKeyOf,
  redactSecrets,
  staticPromptSource,
  type TxSigner,
} from '../src/index.js';
import { buildClient, configFromEnv, loadKeyFile, saveSaltRecord, loadSaltRecord, writeKeyFile } from '../src/node.js';
import { main } from '../src/cli.js';

const C = 'osd.baldingsucks7993.testnet';

function recordingSigner(kind: TxSigner['kind'] = 'full_access') {
  const calls: { contractId: string; method: string; args: object; gas: bigint; deposit: bigint }[] = [];
  const signer: TxSigner = {
    accountId: 'me.testnet',
    kind,
    async call(contractId, method, args, opts) {
      calls.push({ contractId, method, args, ...opts });
      return { txHash: 'h', value: null, logs: [], events: [] };
    },
  };
  return { signer, calls };
}

describe('settleSeasonFully (interfaces-v4 batched settle)', () => {
  const row = { agent_id: 'a', owner: 'o', family: 'f', matches_counted: 1, total_payoff_counted: 3, avg_payoff_milli: 3000, rank: 1, prize_yocto: '1' };
  test('repeats settle_season while it returns [] and returns the ranking', async () => {
    const results: unknown[] = [[], [], [row]];
    const calls: { method: string; gas: bigint }[] = [];
    const signer: TxSigner = {
      accountId: 'k.testnet',
      kind: 'full_access',
      async call(_c, method, _a, opts) {
        calls.push({ method, gas: opts.gas });
        return { txHash: 'h', value: results.shift(), logs: [], events: [] };
      },
    };
    const provider = { view: vi.fn(async () => ({ status: 'play' })) };
    const c = new OsdClient({ contractId: C, provider, signer });
    expect(await c.settleSeasonFully(1)).toEqual([row]);
    expect(calls.map((x) => x.method)).toEqual(['settle_season', 'settle_season', 'settle_season']);
    expect(calls.every((x) => x.gas === 300_000_000_000_000n)).toBe(true);
  });
  test('stops on status settled with an empty ranking, and gives up after maxCalls', async () => {
    const signer: TxSigner = { accountId: 'k', kind: 'full_access', call: async () => ({ txHash: 'h', value: [], logs: [], events: [] }) };
    const settled = new OsdClient({ contractId: C, signer, provider: { view: vi.fn(async (_c: string, m: string) => (m === 'get_season' ? { status: 'settled' } : [])) } });
    expect(await settled.settleSeasonFully(1)).toEqual([]);
    const stuck = new OsdClient({ contractId: C, signer, provider: { view: vi.fn(async () => ({ status: 'play' })) } });
    await expect(stuck.settleSeasonFully(1, { maxCalls: 3 })).rejects.toThrow(/after 3 calls/);
  });
  test('recommended gas defaults', () => {
    const T = 1_000_000_000_000n;
    expect([DEFAULT_GAS.register_agent, DEFAULT_GAS.commit, DEFAULT_GAS.claim, DEFAULT_GAS.play_match, DEFAULT_GAS.schedule_round, DEFAULT_GAS.settle_season, DEFAULT_GAS.open_season]).toEqual(
      [50n * T, 30n * T, 30n * T, 300n * T, 100n * T, 300n * T, 300n * T],
    );
  });
});

describe('OsdClient call encoding', () => {
  const provider = { view: vi.fn(async () => null) };

  test('snake_case args, default gas and deposits', async () => {
    const { signer, calls } = recordingSigner();
    const c = new OsdClient({ contractId: C, provider, signer });
    await c.registerAgent({ name: 'abc', agentPublicKey: 'ed25519:pk' });
    await c.withdraw('abc.' + C, 5n);
    await c.playMatch({ season_id: 1, a: 'z.x', b: 'a.x' });
    await c.claim(3, 'abc.' + C);
    await c.publishPrompt({ seasonId: 1, agentId: 'a', prompt: 'p', salt: '00'.repeat(32) });
    expect(calls.map((x) => [x.method, x.args, x.deposit])).toEqual([
      ['register_agent', { name: 'abc', agent_public_key: 'ed25519:pk' }, parseNear('0.25')],
      ['withdraw', { agent_id: 'abc.' + C, amount_yocto: '5' }, 1n],
      ['play_match', { season_id: 1, a: 'a.x', b: 'z.x' }, MIN_OUTLAYER_DEPOSIT],
      ['claim', { season_id: 3, agent_id: 'abc.' + C }, 0n],
      ['publish_prompt', { season_id: 1, agent_id: 'a', prompt: 'p', salt: '00'.repeat(32) }, 0n],
    ]);
    expect(calls[0]!.gas).toBe(DEFAULT_GAS.register_agent);
    expect(calls.every((x) => x.contractId === C)).toBe(true);
  });

  test('view args: pagination and status omitted unless set', async () => {
    const c = new OsdClient({ contractId: C, provider });
    await c.getMatches(1);
    await c.getMatches(1, { fromIndex: 2, limit: 3, status: 'settled' });
    expect(provider.view.mock.calls).toEqual([
      [C, 'get_matches', { season_id: 1 }],
      [C, 'get_matches', { season_id: 1, from_index: 2, limit: 3, status: 'settled' }],
    ]);
  });

  test('client-side refusals', async () => {
    const c = new OsdClient({ contractId: C, provider });
    await expect(c.claim(1, 'a')).rejects.toThrow(/signer/);
    expect(() => c.agentId('NO')).toThrow(/invalid agent name/);
    expect(c.agentId('tft')).toBe(`tft.${C}`);
    const s = new OsdClient({ contractId: C, provider, signer: recordingSigner().signer });
    await expect(s.registerAgent({ name: 'abc', agentPublicKey: 'x', depositYocto: 1n })).rejects.toThrow(/0.25/);
    await expect(s.fundAgent('a', 0n)).rejects.toThrow(/positive/);
  });

  test('get_published_prompts: typed page args; PromptSource only as fallback', async () => {
    const pv = { view: vi.fn(async (_c: string, m: string) => (m === 'get_published_prompts' ? [] : m === 'get_entries' ? [] : null)) };
    const c = new OsdClient({ contractId: C, provider: pv });
    await c.getPublishedPromptsPage(2);
    await c.getPublishedPromptsPage(2, { fromIndex: 1, limit: 5 });
    expect(pv.view.mock.calls).toEqual([
      [C, 'get_published_prompts', { season_id: 2 }],
      [C, 'get_published_prompts', { season_id: 2, from_index: 1, limit: 5 }],
    ]);
    const old = { view: vi.fn(async (_c: string, m: string) => {
      if (m === 'get_published_prompts') throw new Error('MethodNotFound');
      return [];
    }) };
    await expect(new OsdClient({ contractId: C, provider: old }).getPublishedPrompts({ seasonId: 1 })).rejects.toThrow(/MethodNotFound/);
    const rec = { season_id: 1, agent_id: 'a', family: 'f', prompt: 'p', salt: '0'.repeat(64) };
    const fb = new OsdClient({ contractId: C, provider: old, prompts: staticPromptSource([rec]) });
    expect(await fb.getPublishedPrompts({ seasonId: 1 })).toEqual([{ ...rec, verified: false }]);
  });
});

describe('RpcViewProvider (JSON-RPC call_function)', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('encodes args as base64 JSON and decodes the result', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        const result = [...Buffer.from(JSON.stringify({ season_id: 7 }))];
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { result, logs: [], block_height: 1, block_hash: 'x' } }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const c = new OsdClient({ contractId: C, provider: new RpcViewProvider('https://rpc.invalid') });
    expect(await c.getSeason(7)).toEqual({ season_id: 7 });
    const b = bodies[0] as { method: string; params: Record<string, string> };
    expect(b.method).toBe('query');
    expect(b.params).toMatchObject({ request_type: 'call_function', account_id: C, method_name: 'get_season' });
    expect(JSON.parse(Buffer.from(b.params.args_base64!, 'base64').toString())).toEqual({ season_id: 7 });
  });
});

describe('keys and signers', () => {
  test('agentKeySigner refuses out-of-scope calls before touching the network', async () => {
    const k = generateAgentKey();
    const s = agentKeySigner({ agentId: `a1.${C}`, secretKey: k.secretKey, contractId: C, rpc: 'https://rpc.invalid' });
    expect(s.kind).toBe('function_call');
    const opts = { gas: 1n, deposit: 0n };
    await expect(s.call(C, 'withdraw', {}, opts)).rejects.toBeInstanceOf(ScopeError);
    await expect(s.call('other.testnet', 'commit', {}, opts)).rejects.toThrow(/scoped/);
    await expect(s.call(C, 'commit', {}, { gas: 1n, deposit: 1n })).rejects.toThrow(/deposit/);
  });

  test('invalid secret key error does not echo the key', () => {
    expect(() => agentKeySigner({ agentId: 'a', secretKey: 'garbage-secret', contractId: C, rpc: 'https://x.invalid' })).toThrow(
      /^invalid secret key for a/,
    );
  });

  test('redactSecrets hides secret keys, keeps public keys', () => {
    const k = generateAgentKey();
    const s = redactSecrets(`sk=${k.secretKey} pk=${k.publicKey}`);
    expect(s).not.toContain(k.secretKey.slice(8));
    expect(s).toContain(k.publicKey);
  });

  test('key files: write (0600, no overwrite) and load both formats', () => {
    const dir = mkdtempSync(join(tmpdir(), 'osd-key-'));
    const k = generateAgentKey();
    const p = join(dir, 'agent.json');
    writeKeyFile(p, { account_id: `a1.${C}`, public_key: k.publicKey, private_key: k.secretKey });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(() => writeKeyFile(p, { public_key: '', private_key: '' })).toThrow(/exists/);
    expect(loadKeyFile(p)).toEqual({ account_id: `a1.${C}`, public_key: k.publicKey, private_key: k.secretKey });
    const raw = join(dir, 'raw.key');
    writeFileSync(raw, k.secretKey + '\n');
    expect(loadKeyFile(raw).public_key).toBe(publicKeyOf(k.secretKey));
  });

  test('salt records round trip with mode 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'osd-salt-'));
    const rec = { season_id: 2, agent_id: 'a.x', commitment: 'c', salt: 's', prompt: 'p', family: 'f', parent: null };
    const p = saveSaltRecord(rec, dir);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(loadSaltRecord(2, 'a.x', dir)).toMatchObject(rec);
  });
});

describe('env config', () => {
  test('defaults to mock without RPC; testnet with RPC', () => {
    expect(configFromEnv({}).network).toBe('mock');
    const t = configFromEnv({ OSD_RPC_URL: 'https://r' });
    expect(t).toMatchObject({ network: 'testnet', rpcUrl: 'https://r', contractId: C });
    expect(() => configFromEnv({ OSD_NETWORK: 'mainnet' })).toThrow(/OSD_CONTRACT_ID/);
    expect(() => configFromEnv({ OSD_NETWORK: 'moon' })).toThrow(/OSD_NETWORK/);
  });

  test('buildClient(mock) signs as the agent with FC scope', () => {
    const b = buildClient(configFromEnv({ OSD_AGENT_ID: `tft.${C}`, OSD_MOCK_OPEN_SEASON: '1' }));
    expect(b.client.signer?.kind).toBe('function_call');
    expect(b.chain?.config.current_season_id).toBe(2);
  });
});

describe('helpers', () => {
  test('NEAR amounts and match keys', () => {
    expect(parseNear('0.25')).toBe(250_000_000_000_000_000_000_000n);
    expect(parseNear('3')).toBe(3n * 10n ** 24n);
    expect(formatNear(parseNear('1.22'))).toBe('1.22');
    expect(() => parseNear('1e3')).toThrow();
    expect(matchKeyString(1, 'tft.x', 'grim.x')).toBe('1:grim.x:tft.x');
  });
});

describe('osd CLI (mock)', () => {
  const capture = async (argv: string[], env: Record<string, string> = {}) => {
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
    const old = { ...process.env };
    Object.assign(process.env, { OSD_NETWORK: 'mock' }, env);
    try {
      await main(argv);
    } finally {
      spy.mockRestore();
      process.env = old;
    }
    return out.join('');
  };

  test('status', async () => {
    const s = JSON.parse(await capture(['status', '--agent', `tft.${C}`]));
    expect(s.season.status).toBe('settled');
    expect(s.leaderboard).toHaveLength(6);
    expect(s.agent.owner).toBe('alice.testnet');
  });

  test('keygen never prints the private key; commit saves the salt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osd-cli-'));
    const keyOut = await capture(['keygen', '--out', join(dir, 'k.json'), '--account', `tft.${C}`]);
    const k = loadKeyFile(join(dir, 'k.json'));
    expect(keyOut).not.toContain(k.private_key);
    expect(JSON.parse(keyOut).public_key).toBe(k.public_key);

    writeFileSync(join(dir, 'p.txt'), 'Always cooperate.');
    // tft is a fixture agent with budget; the mock opens a commit-phase season 2
    const r = JSON.parse(
      await capture(['commit', '--agent-key', join(dir, 'k.json'), '--prompt-file', join(dir, 'p.txt'), '--family', 'always_cooperate', '--salt-dir', dir], {
        OSD_MOCK_OPEN_SEASON: '1',
      }),
    );
    expect(r).toMatchObject({ season_id: 2, agent_id: `tft.${C}` });
    expect(JSON.parse(readFileSync(r.salt_file, 'utf8'))).toMatchObject({ commitment: r.commitment, prompt: 'Always cooperate.' });
  });

  test('encrypt', async () => {
    const vec = JSON.parse(readFileSync(new URL('../../../interfaces/fixtures/test-key-vector.json', import.meta.url), 'utf8'));
    const r = JSON.parse(await capture(['encrypt', vec.public_key_hex, 'a.x', 'hello', 'world']));
    expect(Object.keys(r)).toEqual(['ciphertext_hex', 'commitment', 'salt']);
  });
});
