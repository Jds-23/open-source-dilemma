// 12. Outsider lifecycle calls at the wrong time / without the right role.
// Commit phase: open_season, close_commits/schedule_round/play_match/settle_season early,
// commit or withdraw for someone else's agent. Play phase: early settle, refund_void on a
// fresh pending match, extra schedule_round, late commit.
import { actions } from 'near-api-js';
import { actualOf, row, type Attack } from '../lib/attack.ts';
import { ATTACKER, CONTRACT, TGAS, milliNear, send, sleep, view, type TxOutcome } from '../lib/near.ts';
import { allMatches, loadState, type Match, type Season } from '../lib/season.ts';
import type { AttackResult } from '../lib/results.ts';

const call = (method: string, args: Record<string, unknown>, deposit = 0n, gas = 30n): Promise<TxOutcome> =>
  send(ATTACKER, CONTRACT, [actions.functionCall(method, args, gas * TGAS, deposit)]);

function r(id: string, title: string, expected: string, o: TxOutcome, re: RegExp, details?: Record<string, unknown>): AttackResult {
  return row({ id, attack: 12, script: 'outsider-calls', title, expected, actual: actualOf(o), pass: !o.ok && re.test(o.error ?? ''), tx: o.txHash, details });
}

export const outsiderCalls: Attack = {
  name: 'outsider-calls',
  kind: 'both',
  attack: 12,
  summary: 'Outsider open/close/schedule/play/settle/refund/commit/withdraw at the wrong time or without the role',
  async run(ctx) {
    const st = loadState();
    const rows: AttackResult[] = [];
    // Role checks that don't depend on the season phase.
    const params = (await view<Season>('get_season', { season_id: 1 })).params;
    rows.push(r('12a', 'Outsider open_season', 'refused: "owner only"', await call('open_season', { params }, milliNear(20), 300n), /owner only/));
    const victim = `inj-override.${CONTRACT}`;
    rows.push(
      r('12g', 'Outsider withdraw from another owner\'s agent budget', 'refused: "not owner"', await call('withdraw', { agent_id: victim, amount_yocto: '1' }, 1n), /not owner/),
    );
    // Lifecycle calls against the settled season 1: every step is permissionless (anyone may keep the
    // season moving), so the guard is the season phase, not the caller.
    const s1 = await allMatches(1);
    const m1 = s1.find((m) => m.status === 'settled');
    rows.push(r('12l', 'Outsider close_commits on settled season 1', 'refused: "season not in commit"', await call('close_commits', { season_id: 1 }), /season not in commit/));
    rows.push(r('12m', 'Outsider schedule_round on settled season 1 (re-schedule a played pair)', 'refused: "season not in play"', await call('schedule_round', { season_id: 1 }, 0n, 100n), /season not in play/));
    rows.push(r('12n', 'Outsider settle_season again on settled season 1 (double payout)', 'refused: "season not in play"', await call('settle_season', { season_id: 1 }, 0n, 300n), /season not in play/));
    if (m1) {
      rows.push(
        r('12o', 'Outsider refund_void on a settled season-1 match (pull the stakes back)', 'refused: "match not void"', await call('refund_void', { season_id: 1, a: m1.a, b: m1.b }), /match not void/, { match_key: m1.match_key }),
      );
    }
    rows.push(
      r('12p', 'Outsider commits someone else\'s agent into settled season 1', 'refused: "caller must be the agent or its owner"', await call('commit', { season_id: 1, agent_id: victim, ciphertext_hex: '00', commitment: '00'.repeat(32), family: 'x', parent: null }), /caller must be the agent or its owner/),
    );
    if (ctx?.noSeason || st.season_id === null) return rows;
    const sid = st.season_id;
    const s = await view<Season>('get_season', { season_id: sid });
    const es = await view<{ agent_id: string }[]>('get_entries', { season_id: sid, limit: 200 });

    if (s.status === 'commit') {
      rows.push(r('12b', 'Outsider close_commits before the commit deadline', 'refused: "commit deadline not reached"', await call('close_commits', { season_id: sid }), /commit deadline not reached/));
      rows.push(r('12c', 'Outsider schedule_round during commit', 'refused: "season not in play"', await call('schedule_round', { season_id: sid }, 0n, 100n), /season not in play/));
      if (es.length >= 2) {
        rows.push(
          r('12d', 'Early play_match during commit (two entered agents)', 'refused: "season not in play"; OutLayer not called', await call('play_match', { season_id: sid, a: es[0].agent_id, b: es[1].agent_id }, milliNear(20), 300n), /season not in play/),
        );
      }
      rows.push(r('12e', 'Outsider settle_season during commit', 'refused: "season not in play"', await call('settle_season', { season_id: sid }, 0n, 300n), /season not in play/));
      rows.push(
        r('12f', 'Outsider commits on behalf of someone else\'s agent', 'refused: "caller must be the agent or its owner"', await call('commit', { season_id: sid, agent_id: victim, ciphertext_hex: '00', commitment: '00'.repeat(32), family: 'x', parent: null }), /caller must be the agent or its owner/),
      );
    }

    if (s.status === 'play') {
      const ms = await allMatches(sid);
      const unfinished = ms.some((m) => m.status === 'scheduled' || m.status === 'pending');
      if (unfinished) {
        rows.push(r('12h', 'Outsider settle_season while matches are unfinished, before the play deadline', 'refused: "unfinished matches before play deadline"', await call('settle_season', { season_id: sid }, 0n, 300n), /unfinished matches before play deadline/));
      }
      if (s.rounds_scheduled === s.total_rounds) {
        rows.push(r('12j', 'Outsider schedule_round after all rounds are scheduled', 'refused: "all rounds scheduled"', await call('schedule_round', { season_id: sid }, 0n, 100n), /all rounds scheduled/));
      }
      rows.push(
        r('12k', 'Late commit after the commit deadline', 'refused: "season not in commit"', await call('commit', { season_id: sid, agent_id: victim, ciphertext_hex: '00', commitment: '00'.repeat(32), family: 'x', parent: null }), /season not in commit|commit deadline passed|caller must be/),
      );
      // Premature refund: play a scheduled match (anyone may; the outsider pays), then refund it at once.
      const target: Match | undefined = ms.find((m) => m.status === 'scheduled' && process.env.ATK_PREMATURE_REFUND !== '0');
      if (target) {
        const p = await send(ATTACKER, CONTRACT, [actions.functionCall('play_match', { season_id: sid, a: target.a, b: target.b }, 300n * TGAS, milliNear(50))], { waitUntil: 'INCLUDED_FINAL' });
        await sleep(1500);
        const o = await call('refund_void', { season_id: sid, a: target.a, b: target.b });
        rows.push(
          r('12i', 'refund_void on a match that is pending for < 250 blocks (grab the stake back mid-run)', 'refused: "match not void"', o, /match not void/, {
            match_key: target.match_key,
            play_tx: p.txHash,
          }),
        );
      }
    }
    return rows;
  },
};
