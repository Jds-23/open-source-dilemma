// 1. Forged OutLayer callback: call the #[private] callbacks directly from an outsider.
import { actions } from 'near-api-js';
import { row, actualOf, refusedWith, type Attack } from '../lib/attack.ts';
import { ATTACKER, CONTRACT, TGAS, send, view } from '../lib/near.ts';
import type { Match } from '../lib/season.ts';

export const forgedCallback: Attack = {
  name: 'forged-callback',
  kind: 'no-season',
  attack: 1,
  summary: 'Outsider calls on_match / on_pubkey / on_agent_created directly with a forged result',
  async run() {
    const [m] = await view<Match[]>('get_matches', { season_id: 1, limit: 1 });
    const before = JSON.stringify(m);
    const cases = [
      {
        id: '01a',
        method: 'on_match',
        // A forged "I won" referee output can't even be passed: the callback reads the promise result,
        // so the forger can only call the method; we try with the season-1 match key.
        args: { season_id: 1, a: m.a, b: m.b },
        title: 'Forged on_match (season 1 match) from outsider',
      },
      { id: '01b', method: 'on_pubkey', args: { season_id: 1 }, title: 'Forged on_pubkey from outsider' },
      {
        id: '01c',
        method: 'on_agent_created',
        args: { agent_id: `ghost.${CONTRACT}`, owner: ATTACKER, name: 'ghost', deposit: '100000000000000000000000000' },
        title: 'Forged on_agent_created (mint a 100 NEAR budget) from outsider',
      },
    ];
    const rows = [];
    for (const c of cases) {
      const o = await send(ATTACKER, CONTRACT, [actions.functionCall(c.method, c.args, 30n * TGAS, 0n)]);
      const ok = refusedWith(o, new RegExp(`Method ${c.method} is private`));
      rows.push(
        row({
          id: c.id,
          attack: 1,
          script: 'forged-callback',
          title: c.title,
          expected: `refused: "Method ${c.method} is private" (predecessor ≠ contract)`,
          actual: actualOf(o),
          pass: ok,
          tx: o.txHash,
          details: { signer: ATTACKER, args: c.args },
        }),
      );
    }
    const after = JSON.stringify((await view<Match[]>('get_matches', { season_id: 1, limit: 1 }))[0]);
    const ghost = await view<unknown>('get_agent', { agent_id: `ghost.${CONTRACT}` });
    rows[0].details = { ...rows[0].details, match_unchanged: before === after };
    rows[2].details = { ...rows[2].details, ghost_agent: ghost };
    rows[0].pass &&= before === after;
    rows[2].pass &&= ghost === null;
    return rows;
  },
};
