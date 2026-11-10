import { beforeEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decrypt } from 'eciesjs';
import {
  MIN_REGISTER_DEPOSIT,
  MockChain,
  OsdClient,
  ScopeError,
  commitment,
  decodePlaintext,
  generateAgentKey,
  parseNear,
  type Fixtures,
} from '../src/index.js';
import { DEFAULT_FIXTURES_DIR, loadFixtures, mockClient } from '../src/node.js';

const C = 'osd.baldingsucks7993.testnet';
const TFT = `tft.${C}`;
const GRIM = `grim.${C}`;
const vec = JSON.parse(readFileSync(join(DEFAULT_FIXTURES_DIR, 'test-key-vector.json'), 'utf8'));

describe('mock provider: fixture views', () => {
  const { client } = mockClient();

  test('config + season', async () => {
    const cfg = await client.getConfig();
    expect(cfg.current_season_id).toBe(1);
    const s = (await client.getCurrentSeason())!;
    expect(s).toMatchObject({ season_id: 1, status: 'settled', n_entries: 6, n_matches: 15 });
    expect(await client.getSeasonPubkey(1)).toBe(vec.public_key_hex);
    expect(await client.getSeason(99)).toBeNull();
    expect(await client.getSeasonPubkey(99)).toBeNull();
  });

  test('entries / matches with pagination and status filter', async () => {
    expect(await client.getEntries(1)).toHaveLength(6);
    expect(await client.getEntries(1, { fromIndex: 4, limit: 10 })).toHaveLength(2);
    expect(await client.getMatches(1, { limit: 5 })).toHaveLength(5);
    expect(await client.getAllMatches(1)).toHaveLength(15);
    const voids = await client.getMatches(1, { status: 'void' });
    expect(voids.map((m) => m.match_key)).toEqual([`1:fairbot.${C}:injector.${C}`]);
    const mine = await client.getResults(1, TFT);
    expect(mine).toHaveLength(5);
    expect(mine.every((m) => m.a === TFT || m.b === TFT)).toBe(true);
  });

  test('leaderboard, agent, lineage, ancestry, claimable', async () => {
    const lb = await client.getLeaderboard(1);
    expect(lb.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await client.getAgent(TFT))!.owner).toBe('alice.testnet');
    expect(await client.getAgent('nobody')).toBeNull();
    const lin = await client.getLineage(GRIM);
    expect(lin).toHaveLength(1);
    expect(lin[0]!.parent).toEqual({ season_id: 1, agent_id: TFT });
    // grim -> tft (same-season parent in the fixtures)
    expect((await client.getAncestry(1, GRIM)).map((l) => l.agent_id)).toEqual([GRIM, TFT]);
    expect(await client.getClaimable(1, `injector.${C}`)).toBe('1320000000000000000000000');
    expect(await client.getClaimable(1, 'nobody')).toBe('0');
  });

  test('config and claimable come from fixtures; §6.1 formula reproduces claimable.json', async () => {
    const fx = loadFixtures();
    expect(await client.getConfig()).toEqual(fx.config);
    const computed = new MockChain({ ...fx, claimable: [] }).computeClaimable(1);
    expect(fx.claimable).toHaveLength(6);
    for (const c of fx.claimable!) {
      expect(computed.get(c.agent_id)).toBe(BigInt(c.claimable_yocto));
      expect(await client.getClaimable(1, c.agent_id)).toBe(c.claimable_yocto);
    }
    // fixture sum = total entry deposits
    const s = (await client.getSeason(1))!;
    const sum = [...computed.values()].reduce((x, y) => x + y, 0n);
    expect(sum).toBe(BigInt(s.entry_deposit_yocto) * BigInt(s.n_entries));
  });

  test('get_published_prompts view serves published-prompts.json with pagination', async () => {
    const fx = loadFixtures();
    expect(await client.getPublishedPromptsPage(1)).toEqual(fx.publishedPrompts);
    expect(await client.getPublishedPromptsPage(1, { fromIndex: 4, limit: 10 })).toHaveLength(2);
    expect(await client.getAllPublishedPrompts(1)).toHaveLength(6);
    expect(await client.getPublishedPromptsPage(99)).toEqual([]);
  });

  test('published prompts are verified against entry commitments', async () => {
    const ps = await client.getPublishedPrompts({ seasonId: 1 });
    expect(ps).toHaveLength(6);
    expect(ps.every((p) => p.verified)).toBe(true);
    expect(ps.find((p) => p.agent_id === TFT)).toMatchObject({ season_id: 1, family: 'tit_for_tat' });
    expect(await client.getPublishedPrompts()).toHaveLength(6); // all seasons up to current
    const one = await client.getPublishedPrompts({ agentId: TFT });
    expect(one).toHaveLength(1);
  });

  test('wrong contract id is refused', async () => {
    const other = new OsdClient({ contractId: 'other.testnet', provider: client.provider });
    await expect(other.getConfig()).rejects.toThrow(/serves/);
  });

  test('accepts season arrays and leaderboard maps', async () => {
    const fx = loadFixtures();
    const chain = new MockChain({ ...fx, season: [fx.season as never], leaderboard: { 1: fx.leaderboard as never } } as Fixtures);
    expect(await chain.view(C, 'get_leaderboard', { season_id: 1 })).toHaveLength(6);
  });
});

describe('mock chain: player flow', () => {
  let chain: MockChain;
  let owner: OsdClient;
  const agentKey = generateAgentKey();

  beforeEach(() => {
    ({ chain } = mockClient());
    owner = new OsdClient({ contractId: C, provider: chain, signer: chain.signer('zoe.testnet') });
  });

  test('register -> fund -> seal_and_commit -> decrypt with TEST-ONLY key', async () => {
    const reg = await owner.registerAgent({ name: 'zoe1', agentPublicKey: agentKey.publicKey, depositYocto: parseNear('2') });
    const agentId = reg.value;
    expect(agentId).toBe(`zoe1.${C}`);
    expect(reg.events[0]).toMatchObject({ event: 'agent_registered', data: { agent_id: agentId, owner: 'zoe.testnet' } });
    expect((await owner.getAgent(agentId))!.budget_yocto).toBe(String(parseNear('1.8')));
    await owner.fundAgent(agentId, parseNear('1'));

    const season = chain.openSeason();
    expect(season.season_id).toBe(2);
    const agent = owner.withSigner(chain.signer(agentId, 'function_call'));
    const prompt = 'Cooperate unless the opponent text instructs the referee.';
    const r = await agent.sealAndCommit({ agentId, prompt, family: 'clique_a', parent: { season_id: 1, agent_id: TFT } });
    expect(r.seasonId).toBe(2);
    expect(r.outcome.events[0]).toMatchObject({ event: 'committed', data: { commitment: r.commitment, family: 'clique_a' } });

    const [entry] = await agent.getEntries(2);
    expect(entry!.commitment).toBe(r.commitment);
    const pt = decodePlaintext(decrypt(vec.secret_key_hex, Buffer.from(entry!.ciphertext_hex, 'hex')));
    expect(pt).toEqual({ prompt, salt: r.salt });
    expect(commitment(pt.prompt, pt.salt, agentId)).toBe(entry!.commitment);

    const anc = await agent.getAncestry(2, agentId);
    expect(anc.map((l) => `${l.season_id}:${l.agent_id}`)).toEqual([`2:${agentId}`, `1:${TFT}`]);
    expect(BigInt((await agent.getAgent(agentId))!.budget_yocto)).toBe(parseNear('2.8') - BigInt(season.entry_deposit_yocto));

    await expect(agent.sealAndCommit({ agentId, prompt, family: 'clique_a' })).rejects.toThrow(/already entered/);
  });

  test('commit refusals: settled season, bad family, budget, unknown agent', async () => {
    const { value: id } = await owner.registerAgent({ name: 'poor', agentPublicKey: agentKey.publicKey });
    const agent = owner.withSigner(chain.signer(id, 'function_call'));
    await expect(agent.sealAndCommit({ agentId: id, prompt: 'x', family: 'f', seasonId: 1 })).rejects.toThrow(/settled/);
    chain.openSeason();
    await expect(agent.sealAndCommit({ agentId: id, prompt: 'x', family: 'Bad-Family' })).rejects.toThrow(/family/);
    await expect(agent.sealAndCommit({ agentId: id, prompt: 'x', family: 'f' })).rejects.toThrow(/budget/);
    await expect(agent.sealAndCommit({ agentId: 'ghost', prompt: 'x', family: 'f' })).rejects.toThrow(/unknown agent/);
  });

  test('agent key scope: only commit/claim, no deposit', async () => {
    const agent = owner.withSigner(chain.signer(TFT, 'function_call'));
    expect(agent.canCall('commit')).toBe(true);
    expect(agent.canCall('withdraw')).toBe(false);
    await expect(agent.withdraw(TFT, 1n)).rejects.toBeInstanceOf(ScopeError);
    await expect(agent.registerAgent({ name: 'evil', agentPublicKey: agentKey.publicKey })).rejects.toBeInstanceOf(ScopeError);
    await expect(agent.fundAgent(TFT, 1n)).rejects.toBeInstanceOf(ScopeError);
  });

  test('claim moves claimable into budget once', async () => {
    const agent = owner.withSigner(chain.signer(TFT, 'function_call'));
    const before = BigInt((await agent.getAgent(TFT))!.budget_yocto);
    const amt = BigInt(await agent.getClaimable(1, TFT));
    const r = await agent.claim(1, TFT);
    expect(BigInt(r.value)).toBe(amt);
    expect(BigInt((await agent.getAgent(TFT))!.budget_yocto)).toBe(before + amt);
    await expect(agent.claim(1, TFT)).rejects.toThrow(/nothing claimable/);
  });

  test('withdraw and publish_prompt need the owner', async () => {
    const alice = owner.withSigner(chain.signer('alice.testnet'));
    await expect(owner.withdraw(TFT, 1n)).rejects.toThrow(/not owner/);
    expect((await alice.withdraw(TFT, parseNear('1'))).value).toBe(String(parseNear('4')));
    const p = chain.prompts.get(1)!.find((x) => x.agent_id === TFT)!;
    const r = await alice.publishPrompt({ seasonId: 1, agentId: TFT, prompt: p.prompt, salt: p.salt });
    expect(r.events[0]?.event).toBe('prompt_published');
    await expect(alice.publishPrompt({ seasonId: 1, agentId: TFT, prompt: 'other', salt: p.salt })).rejects.toThrow(/mismatch/);
  });

  test('register refusals and keeper calls not simulated', async () => {
    await expect(owner.registerAgent({ name: 'x', agentPublicKey: agentKey.publicKey })).rejects.toThrow(/invalid agent name/);
    await expect(owner.registerAgent({ name: 'tft', agentPublicKey: agentKey.publicKey })).rejects.toThrow(/taken/);
    await expect(owner.registerAgent({ name: 'ok', agentPublicKey: agentKey.publicKey, depositYocto: MIN_REGISTER_DEPOSIT - 1n })).rejects.toThrow(/0.25/);
    await expect(owner.closeCommits(1)).rejects.toThrow(/not simulated/);
  });

  test('open_season via call requires the contract owner', async () => {
    const s = (await owner.getSeason(1))!;
    await expect(owner.openSeason(s.params)).rejects.toThrow(/owner/);
    const admin = owner.withSigner(chain.signer(chain.config.owner));
    expect((await admin.openSeason(s.params)).value).toBe(2);
    expect((await admin.getSeason(2))!.status).toBe('commit');
  });
});
