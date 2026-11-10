import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { badgeTokenId, buildCardRows, cardTokenId, chunk, resolveFamily, settleTxFrom } from '../src/cards.ts';

describe('cards', () => {
  test('token ids match contracts/cards', () => {
    assert.equal(cardTokenId(1, 'a.osd.testnet'), 's1:a.osd.testnet');
    assert.equal(badgeTokenId(12), 'badge:s12');
  });

  test('family: plan, then entry, then unknown', () => {
    const plan = new Map([['a', 'clique']]);
    assert.equal(resolveFamily('a', 'nice', plan), 'clique');
    assert.equal(resolveFamily('b', 'mean', plan), 'mean');
    assert.equal(resolveFamily('b', '', plan), 'unknown');
    assert.equal(resolveFamily('b', 'Bad Family!', plan), 'unknown');
  });

  test('rows follow leaderboard order and carry entry data', () => {
    const lb = [
      { agent_id: 'b', owner: 'ob', family: 'mean', avg_payoff_milli: 2555, rank: 1 },
      { agent_id: 'a', owner: 'oa', family: 'nice', avg_payoff_milli: 1000, rank: 2 },
    ];
    const entries = [
      { agent_id: 'a', owner: 'oa', family: 'nice', parent: null, commitment: 'c1' },
      { agent_id: 'b', owner: 'ob', family: 'mean', parent: { season_id: 1, agent_id: 'z' }, commitment: 'c2' },
      { agent_id: 'c', owner: 'oc', family: '', parent: null, commitment: 'c3' },
    ];
    const rows = buildCardRows(lb, entries);
    assert.deepEqual(rows.map((r) => r.agent_id), ['b', 'a', 'c']);
    assert.deepEqual(rows[0], { agent_id: 'b', owner: 'ob', family: 'mean', rank: 1, avg_payoff_milli: 2555, commitment: 'c2', parent: { season_id: 1, agent_id: 'z' } });
    assert.equal(rows[2]!.rank, null);
    assert.equal(rows[2]!.family, 'unknown');
    assert.throws(() => buildCardRows(lb, entries.slice(0, 1)), /no entry/);
  });

  test('chunk and settle tx lookup', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    const recs = [
      { kind: 'tx', method: 'settle_season', outcome: 'ok', tx_hash: 'X1', season_id: 1 },
      { kind: 'tx', method: 'settle_season', outcome: 'ok', tx_hash: 'X2', season_id: 1 },
      { kind: 'tx', method: 'settle_season', outcome: 'refused', season_id: 1 },
      { kind: 'tx', method: 'settle_season', outcome: 'ok', tx_hash: 'Y', season_id: 2 },
    ];
    assert.equal(settleTxFrom(recs, 1), 'X2');
    assert.equal(settleTxFrom(recs, 3), null);
  });
});
