import { afterEach, describe, expect, it, vi } from 'vitest';
import { cardsFromEnv } from '@/lib/cards';

afterEach(() => vi.unstubAllGlobals());

const card = (season: number, kind = 'card') => ({
  token_id: kind === 'card' ? `s${season}:a.osd.testnet` : `badge:s${season}`,
  owner_id: 'h1.testnet',
  supply: '1',
  metadata: { kind, title: 't', season_id: season, core_contract: 'osd.testnet', settle_tx: null, agent_id: 'a.osd.testnet', family: 'nice', rank: 1, avg_payoff_milli: 2555, commitment: 'ab', parent_card: null, minted_at_ns: '1' },
});

describe('cards source', () => {
  it('hidden without NEXT_PUBLIC_CARDS_CONTRACT_ID', () => {
    expect(cardsFromEnv({})).toBeNull();
  });
  it('reads cards_for_agent from the cards contract, newest season first', async () => {
    vi.stubGlobal('fetch', async (_u: string, init?: RequestInit) => {
      const p = JSON.parse(String(init?.body)).params;
      expect(p).toMatchObject({ account_id: 'cards.osd.testnet', method_name: 'cards_for_agent' });
      expect(JSON.parse(Buffer.from(p.args_base64, 'base64').toString())).toEqual({ agent_id: 'a.osd.testnet' });
      return new Response(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify([card(1), card(2), card(2, 'badge')]))] } }));
    });
    const src = cardsFromEnv({ NEXT_PUBLIC_CARDS_CONTRACT_ID: 'cards.osd.testnet', NEXT_PUBLIC_RPC_URL: 'http://rpc' })!;
    expect((await src.cardsForAgent('a.osd.testnet')).map((c) => c.token_id)).toEqual(['s2:a.osd.testnet', 's1:a.osd.testnet']);
  });
  it('rpc errors -> no cards', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { name: 'HANDLER_ERROR' } })));
    expect(await cardsFromEnv({ NEXT_PUBLIC_CARDS_CONTRACT_ID: 'x.testnet' })!.cardsForAgent('a')).toEqual([]);
  });
});
