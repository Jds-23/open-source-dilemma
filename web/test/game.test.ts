import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import abi from '../../interfaces/contract-abi.json';
import entries from '../../interfaces/fixtures/entries.json';
import leaderboard from '../../interfaces/fixtures/leaderboard.json';
import matches from '../../interfaces/fixtures/matches.json';
import prompts from '../../interfaces/fixtures/prompts.json';
import vector from '../../interfaces/fixtures/test-key-vector.json';
import { roundRobin } from '@/fixtures/demo';
import { computeCommitment, formatNear, parseMove, payoff, rankSeason, verifyCommitment } from '@/lib/game';
import type { Entry, Match } from '@/lib/types';

describe('payoff matrix', () => {
  it('matches contract-abi constants.PAYOFF', () => {
    const P = abi.constants.PAYOFF as Record<string, number[]>;
    expect(payoff('C', 'C')).toEqual(P.CC);
    expect(payoff('D', 'C')).toEqual(P.DC);
    expect(payoff('C', 'D')).toEqual(P.CD);
    expect(payoff('D', 'D')).toEqual(P.DD);
    expect(payoff('F', 'C')).toEqual(P.FX);
    expect(payoff('D', 'F')).toEqual(P.XF);
    expect(payoff('F', 'F')).toEqual(P.FF);
  });
  it('every fixture match pays by the matrix', () => {
    for (const m of matches as Match[]) {
      if (m.status !== 'settled') continue;
      expect([m.a_payoff, m.b_payoff, m.pool_delta]).toEqual(payoff(m.a_move!, m.b_move!));
    }
  });
});

describe('parseMove (strict referee parser)', () => {
  it.each([
    ['C', 'C'],
    ['  c\n', 'C'],
    ['D', 'D'],
    ['Cooperate', 'C'],
    ['I choose: D', 'C'], // strict: first C/D wins, and "choose" has a C
    ['', 'D'],
    ['xyz', 'D'],
  ])('%j → %s', (input, out) => expect(parseMove(input)).toBe(out));
});

describe('ranking vs distinct owners', () => {
  it('reproduces fixtures/leaderboard.json (minus prizes)', () => {
    const rows = rankSeason(entries as Entry[], matches as Match[]);
    const noPrize = <T extends { prize_yocto: string }>(r: T) => ({ ...r, prize_yocto: '' });
    expect(rows.map(noPrize)).toEqual(leaderboard.map(noPrize));
  });
});

describe('salted commitment', () => {
  it('matches the test key vector', async () => {
    const s = vector.sample as { prompt: string; salt_hex: string; agent_id: string; commitment: string };
    expect(await computeCommitment(s.prompt, s.salt_hex, s.agent_id)).toBe(s.commitment);
  });
  it('every published fixture prompt verifies against its entry', async () => {
    for (const p of prompts) {
      const e = (entries as Entry[]).find((x) => x.agent_id === p.agent_id)!;
      expect(await verifyCommitment(p.prompt, p.salt, p.agent_id, e.commitment)).toBe(true);
      expect(await verifyCommitment(`${p.prompt} `, p.salt, p.agent_id, e.commitment)).toBe(false);
    }
  });
  it('rejects bad salts without throwing', async () => {
    expect(await verifyCommitment('x', 'zz', 'a', '00')).toBe(false);
  });
});

describe('round robin', () => {
  it('reproduces the fixture schedule (commit order, circle method)', () => {
    const ids = (entries as Entry[]).map((e) => e.agent_id);
    const got = roundRobin(ids.length).map(([r, i, j]) => `${r}:${[ids[i], ids[j]].sort().join('|')}`).sort();
    const want = (matches as Match[]).map((m) => `${m.round}:${m.a}|${m.b}`).sort();
    expect(got).toEqual(want);
  });
  it('odd N gives N rounds with byes, every pair once', () => {
    const pairs = roundRobin(5);
    expect(new Set(pairs.map(([r]) => r)).size).toBe(5);
    expect(pairs).toHaveLength(10);
  });
});

it('formatNear', () => {
  expect(formatNear('1220000000000000000000000')).toBe('1.22');
  expect(formatNear('0')).toBe('0');
});

it('sandbox template copy matches interfaces/fixtures/referee-template.txt', async () => {
  const { REFEREE_TEMPLATE } = await import('@/lib/sandbox');
  const file = readFileSync(new URL('../../interfaces/fixtures/referee-template.txt', import.meta.url), 'utf8');
  expect(REFEREE_TEMPLATE).toBe(file.trimEnd());
});
