import { describe, expect, test } from 'vitest';
import { CardsViews, badgeTokenId, cardTokenId, type ViewProvider } from '../src/index.js';

describe('cards views', () => {
  test('token ids', () => {
    expect(cardTokenId(1, 'a.osd.testnet')).toBe('s1:a.osd.testnet');
    expect(badgeTokenId(1)).toBe('badge:s1');
  });
  test('calls the cards contract and decodes U128', async () => {
    const calls: [string, string, object][] = [];
    const provider: ViewProvider = {
      async view(contractId, method, args) {
        calls.push([contractId, method, args]);
        if (method === 'mt_balance_of') return '2';
        if (method === 'mt_supply') return null;
        return [];
      },
    };
    const c = new CardsViews(provider, 'cards.osd.testnet');
    expect(await c.mtBalanceOf('h1.testnet', 'badge:s1')).toBe(2n);
    expect(await c.mtSupply('nope')).toBeNull();
    expect(await c.cardsForAgent('a.osd.testnet')).toEqual([]);
    expect(calls).toEqual([
      ['cards.osd.testnet', 'mt_balance_of', { account_id: 'h1.testnet', token_id: 'badge:s1' }],
      ['cards.osd.testnet', 'mt_supply', { token_id: 'nope' }],
      ['cards.osd.testnet', 'cards_for_agent', { agent_id: 'a.osd.testnet' }],
    ]);
  });
});
