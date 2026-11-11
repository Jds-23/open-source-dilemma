// 2. Replay a played match: play_match on the same (season, a, b) again.
import { actions } from 'near-api-js';
import { actualOf, outlayerTouched, refusedWith, row, type Attack } from '../lib/attack.ts';
import { ATTACKER, CONTRACT, TGAS, milliNear, send } from '../lib/near.ts';
import { allMatches, loadState, type Match } from '../lib/season.ts';
import type { AttackResult } from '../lib/results.ts';
import { view } from '../lib/near.ts';

async function replay(id: string, title: string, m: Match, reversed: boolean): Promise<AttackResult> {
  const [a, b] = reversed ? [m.b, m.a] : [m.a, m.b];
  const before = JSON.stringify(m);
  const o = await send(ATTACKER, CONTRACT, [
    actions.functionCall('play_match', { season_id: m.season_id, a, b }, 300n * TGAS, milliNear(20)),
  ]);
  const season = await view<{ status: string }>('get_season', { season_id: m.season_id });
  const expectMsg = season.status === 'play' ? /match not scheduled/ : /season not in play/;
  const now = (await allMatches(m.season_id)).find((x) => x.a === m.a && x.b === m.b);
  const unchanged = JSON.stringify(now) === before;
  const noOutlayer = !outlayerTouched(o);
  return row({
    id,
    attack: 2,
    script: 'replay',
    title,
    expected: `refused (${season.status === 'play' ? '"match not scheduled"' : '"season not in play"'}), OutLayer not called, match unchanged`,
    actual: `${actualOf(o)}; OutLayer receipts: ${noOutlayer ? 'none' : 'YES'}; match ${unchanged ? 'unchanged' : 'CHANGED'}`,
    pass: refusedWith(o, expectMsg) && noOutlayer && unchanged,
    tx: o.txHash,
    details: { match_key: m.match_key, status_before: m.status, args_order: reversed ? 'b,a' : 'a,b', deposit_refunded: !o.ok },
  });
}

export const replayAttack: Attack = {
  name: 'replay',
  kind: 'both',
  attack: 2,
  summary: 'Replay settled/void matches with play_match (same key, also reversed a/b)',
  async run(ctx) {
    const rows: AttackResult[] = [];
    const s1 = await allMatches(1);
    const settled1 = s1.find((m) => m.status === 'settled');
    if (settled1) rows.push(await replay('02a', 'Replay settled season-1 match (season settled)', settled1, false));
    const sid = ctx?.noSeason ? null : loadState().season_id;
    if (sid !== null) {
      const ms = await allMatches(sid);
      const settled = ms.find((m) => m.status === 'settled');
      const voided = ms.find((m) => m.status === 'void' || m.status === 'refunded');
      if (settled) rows.push(await replay('02b', `Replay settled attack-season match (season ${sid}), args reversed`, settled, true));
      if (voided) rows.push(await replay('02c', `Replay ${voided.status} attack-season match (${voided.void_reason ?? '?'})`, voided, false));
    }
    return rows;
  },
};
