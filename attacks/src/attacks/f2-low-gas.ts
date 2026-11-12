// F2 re-run (interfaces-v7): an outsider's low-gas play_match must be refused before any state change.
// Targets a scheduled match of the current season if one exists (it must stay scheduled), else the
// first match of the latest season: the gas floor is checked first, so the refusal text is the same
// and nothing is consumed. One tx per gas value; costs only the tx fee (the 0.02 NEAR deposit is refunded).
import { actions } from 'near-api-js';
import { refusedWith, row, type Attack } from '../lib/attack.ts';
import { ATTACKER, CONTRACT, TGAS, milliNear, send, view } from '../lib/near.ts';
import { allMatches, findMatch, type Match } from '../lib/season.ts';
import type { AttackResult } from '../lib/results.ts';

const REFUSAL = /insufficient gas: attach at least 210 Tgas/;

export const f2LowGas: Attack = {
  name: 'f2-low-gas',
  kind: 'both',
  attack: 13,
  summary: 'F2 fix: play_match with starved gas is refused (insufficient gas), the match is never voided by an outsider',
  async run() {
    const cfg = await view<{ current_season_id?: number | null }>('get_config');
    const sid = cfg.current_season_id ?? 0;
    if (!sid) return [];
    const ms = await allMatches(sid);
    const target: Match | undefined = ms.find((m) => m.status === 'scheduled') ?? ms[0];
    if (!target) return [];
    const rows: AttackResult[] = [];
    for (const g of (process.env.ATK_LOW_GAS_TGAS ?? '50,209').split(',').map((x) => BigInt(x))) {
      const o = await send(ATTACKER, CONTRACT, [actions.functionCall('play_match', { season_id: sid, a: target.a, b: target.b }, g * TGAS, milliNear(20))]);
      const after = findMatch(await allMatches(sid), target.a, target.b)!;
      const refused = refusedWith(o, REFUSAL);
      const outlayer = o.receipts.filter((r) => r.executor === 'outlayer.testnet');
      rows.push(
        row({
          id: `13f-${g}`,
          attack: 13,
          script: 'f2-low-gas',
          title: `F2 re-run: outsider play_match with ${g} Tgas (season ${sid}, ${target.status} match ${target.match_key.split(':').slice(1).map((x) => x.split('.')[0]).join(' vs ')})`,
          expected: 'refused "insufficient gas: attach at least 210 Tgas"; no OutLayer call; match status unchanged',
          actual: `${o.ok ? 'tx ok' : `refused: ${o.error?.slice(0, 120)}`}; OutLayer receipts ${outlayer.length}; match ${target.status} → ${after.status}`,
          pass: refused && outlayer.length === 0 && after.status === target.status,
          tx: o.txHash,
          details: { match_key: target.match_key, gas_tgas: Number(g), status_before: target.status, status_after: after.status },
        }),
      );
    }
    return rows;
  },
};
