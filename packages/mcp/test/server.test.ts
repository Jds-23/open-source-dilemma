import { describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { decrypt } from 'eciesjs';
import { decodePlaintext, generateAgentKey, type OsdClient } from '@osd/sdk';
import { DEFAULT_FIXTURES_DIR, buildClient, configFromEnv, mockClient, saveSaltRecord } from '@osd/sdk/node';
import { createOsdMcpServer } from '../src/server.js';

const C = 'osd.baldingsucks7993.testnet';
const TFT = `tft.${C}`;
const vec = JSON.parse(readFileSync(join(DEFAULT_FIXTURES_DIR, 'test-key-vector.json'), 'utf8'));

async function connect(client: OsdClient, agentId?: string, saltDir?: string) {
  const server = createOsdMcpServer({
    client,
    agentId,
    network: 'mock',
    saveSalt: saltDir ? (r) => saveSaltRecord(r, saltDir) : undefined,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(ct);
  return mcp;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
const json = (r: unknown) => JSON.parse(text(r));

describe('osd MCP server', () => {
  test('tool list snapshot', async () => {
    const mcp = await connect(mockClient().client, TFT);
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'whoami',
      'get_season',
      'get_leaderboard',
      'get_matches',
      'get_agent',
      'get_lineage',
      'get_claimable',
      'list_past_prompts',
      'seal_and_commit',
      'claim',
    ]);
    // stable subset (SDK-added fields like execution/_meta excluded)
    expect(tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }))).toMatchSnapshot();
  });

  test('get_leaderboard against the fixture mock', async () => {
    const mcp = await connect(mockClient().client);
    const rows = json(await mcp.callTool({ name: 'get_leaderboard', arguments: {} }));
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ rank: 1, agent_id: `injector.${C}` });
  });

  test('read tools: season, matches, lineage, prompts, claimable', async () => {
    const mcp = await connect(mockClient().client, TFT);
    expect(json(await mcp.callTool({ name: 'get_season', arguments: { season_id: 1 } }))).toMatchObject({ status: 'settled' });
    const ms = json(await mcp.callTool({ name: 'get_matches', arguments: { agent_id: TFT } }));
    expect(ms).toHaveLength(5);
    expect(ms[0]).not.toHaveProperty('a_sig');
    expect(json(await mcp.callTool({ name: 'get_matches', arguments: { status: 'void' } }))).toHaveLength(1);
    expect(json(await mcp.callTool({ name: 'get_lineage', arguments: {} }))[0]).toMatchObject({ agent_id: TFT, rank: 4 });
    const ps = json(await mcp.callTool({ name: 'list_past_prompts', arguments: { family: 'injector' } }));
    expect(ps).toEqual([expect.objectContaining({ family: 'injector', verified: true, rank: 1 })]);
    expect(json(await mcp.callTool({ name: 'list_past_prompts', arguments: { season_id: 1 } }))).toHaveLength(6);
    expect(json(await mcp.callTool({ name: 'get_claimable', arguments: { season_id: 1 } })).claimable_yocto).toMatch(/^[1-9]\d+$/);
    const r = await mcp.callTool({ name: 'get_agent', arguments: { agent_id: 'nobody' } });
    expect(r.isError).toBe(true);
  });

  test('seal_and_commit (mock): commits, saves the salt privately, never returns salt or keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osd-mcp-'));
    const { client, chain } = mockClient({ signerAccountId: TFT, signerKind: 'function_call' });
    chain.openSeason();
    const mcp = await connect(client, TFT, dir);

    const who = json(await mcp.callTool({ name: 'whoami', arguments: {} }));
    expect(who).toMatchObject({ agent_id: TFT, signer: { account_id: TFT, key_kind: 'function_call' }, can_commit: true });

    const prompt = 'Cooperate with any opponent that commits to cooperating with this text.';
    const res = await mcp.callTool({
      name: 'seal_and_commit',
      arguments: { prompt, family: 'fairbot', parent_season_id: 1, parent_agent_id: TFT },
    });
    expect(res.isError).toBeFalsy();
    const out = json(res);
    expect(out).toMatchObject({ season_id: 2, agent_id: TFT, events: ['committed'] });

    const rec = JSON.parse(readFileSync(out.salt_saved_to, 'utf8'));
    expect(rec).toMatchObject({ season_id: 2, agent_id: TFT, commitment: out.commitment, prompt });
    expect(text(res)).not.toContain(rec.salt);

    const [entry] = chain.entries.filter((e) => e.season_id === 2);
    expect(entry).toMatchObject({ commitment: out.commitment, parent: { season_id: 1, agent_id: TFT } });
    expect(decodePlaintext(decrypt(vec.secret_key_hex, Buffer.from(entry!.ciphertext_hex, 'hex')))).toEqual({ prompt, salt: rec.salt });

    const again = await mcp.callTool({ name: 'seal_and_commit', arguments: { prompt, family: 'fairbot' } });
    expect(again.isError).toBe(true);
    expect(text(again)).toMatch(/already entered/);
  });

  test('claim (mock)', async () => {
    const { client } = mockClient({ signerAccountId: TFT, signerKind: 'function_call' });
    const mcp = await connect(client, TFT);
    const out = json(await mcp.callTool({ name: 'claim', arguments: { season_id: 1 } }));
    expect(out.claimed_yocto).toMatch(/^[1-9]\d+$/);
  });

  test('without a signer, write tools fail cleanly', async () => {
    const mcp = await connect(mockClient().client, TFT);
    const r = await mcp.callTool({ name: 'claim', arguments: { season_id: 1 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/no signer/);
  });

  test('errors are redacted: a secret key in an error never reaches the transcript', async () => {
    const k = generateAgentKey();
    const { client } = mockClient();
    const leaky = {
      ...client,
      getConfig: async () => {
        throw new Error(`boom with ${k.secretKey}`);
      },
    } as unknown as OsdClient;
    const mcp = await connect(leaky);
    const r = await mcp.callTool({ name: 'get_season', arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).not.toContain(k.secretKey);
    expect(text(r)).toContain('<redacted>');
  });

  test('env-built mock client (OSD_NETWORK unset => fixtures)', async () => {
    const { client, agentId } = buildClient(configFromEnv({ OSD_AGENT_ID: TFT }));
    const mcp = await connect(client, agentId);
    expect(json(await mcp.callTool({ name: 'whoami', arguments: {} })).contract_id).toBe(C);
  });
});
