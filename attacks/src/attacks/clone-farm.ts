// 9. Clone farm: one owner enters max_entries_per_owner (3) agents; a 4th commit is refused.
// Same-owner matches still pay but are excluded from ranking (leaderboard matches_counted).
import { sealPrompt } from '@osd/sdk';
import { actualOf, row, type Attack } from '../lib/attack.ts';
import { CLONE_OWNER, view } from '../lib/near.ts';
import { agentId, allMatches, commitEntry, loadPlan, loadState, readPrompt, saveSalt, saveState, type LeaderboardRow, type Season } from '../lib/season.ts';
import type { AttackResult } from '../lib/results.ts';

export const cloneFarm: Attack = {
  name: 'clone-farm',
  kind: 'season',
  attack: 9,
  summary: 'One owner, 4 agents: 4th commit refused at the cap; same-owner matches excluded from ranking',
  async run() {
    const st = loadState();
    if (st.season_id === null) return [];
    const sid = st.season_id;
    const s = await view<Season>('get_season', { season_id: sid });
    const clones = loadPlan().agents.filter((a) => a.roles.includes('clone'));
    const rows: AttackResult[] = [];

    if (s.status === 'commit') {
      for (const a of clones) {
        const id = agentId(a.name);
        if (st.commits[id] || st.notes[`refused ${id}`]) continue;
        const sealed = sealPrompt(s.pubkey!, readPrompt(a.prompt_file), id);
        saveSalt(id, { salt: sealed.salt, commitment: sealed.commitment, prompt_file: a.prompt_file });
        // Owner-signed commit (the owner may commit for its agent), like a farm script would.
        const o = await commitEntry(sid, id, sealed.ciphertext_hex, sealed.commitment, a.family, CLONE_OWNER);
        console.log(`clone commit ${id}: ${actualOf(o)} ${o.txHash}`);
        if (o.ok) st.commits[id] = { tx: o.txHash, kind: 'honest' };
        else st.notes[`refused ${id}`] = { tx: o.txHash, error: o.error };
        saveState(st);
      }
    }
    const over = clones.find((a) => a.roles.includes('over-cap'));
    const overId = over ? agentId(over.name) : '';
    const refused = st.notes[`refused ${overId}`] as { tx: string; error: string } | undefined;
    const es = await view<{ agent_id: string; owner: string }[]>('get_entries', { season_id: sid, limit: 200 });
    const ownerEntries = es.filter((e) => e.owner === CLONE_OWNER).length;
    if (refused || st.commits[overId]) {
      rows.push(
        row({
          id: '09a',
          attack: 9,
          script: 'clone-farm',
          title: `4th agent of one owner commits (cap max_entries_per_owner = ${s.params.max_entries_per_owner})`,
          expected: 'refused: "owner reached max_entries_per_owner"; owner keeps 3 entries',
          actual: refused ? `refused: ${refused.error}; owner has ${ownerEntries} entries` : `ACCEPTED; owner has ${ownerEntries} entries`,
          pass: !!refused && /owner reached max_entries_per_owner/.test(refused.error) && ownerEntries === s.params.max_entries_per_owner,
          tx: refused?.tx ?? st.commits[overId]?.tx,
        }),
      );
    }
    if (s.status !== 'play' && s.status !== 'settled') return rows;

    const ms = await allMatches(sid);
    const owner = new Map(es.map((e) => [e.agent_id, e.owner]));
    const lb = await view<LeaderboardRow[]>('get_leaderboard', { season_id: sid });
    const check = lb.map((r) => {
      const settled = ms.filter((m) => m.status === 'settled' && (m.a === r.agent_id || m.b === r.agent_id));
      const cross = settled.filter((m) => owner.get(m.a) !== owner.get(m.b));
      const crossPay = cross.reduce((t, m) => t + (m.a === r.agent_id ? m.a_payoff : m.b_payoff), 0);
      return { agent: r.agent_id.split('.')[0], owner: r.owner.split('.')[0], settled: settled.length, same_owner: settled.length - cross.length, counted: r.matches_counted, expect_counted: cross.length, total: r.total_payoff_counted, expect_total: crossPay, rank: r.rank, avg: r.avg_payoff_milli };
    });
    const sameOwnerMatches = ms.filter((m) => owner.get(m.a) === owner.get(m.b));
    const ok = check.every((c) => c.counted === c.expect_counted && c.total === c.expect_total);
    const clonesRows = check.filter((c) => c.owner === CLONE_OWNER.split('.')[0]);
    rows.push(
      row({
        id: '09b',
        attack: 9,
        script: 'clone-farm',
        title: `Ranking excludes the ${sameOwnerMatches.length} clone-vs-clone matches (leaderboard, season ${sid}, ${s.status})`,
        expected: 'matches_counted / total_payoff_counted use only matches vs other owners; same-owner matches still pay out',
        actual: `${ok ? 'all' : 'NOT all'} ${check.length} rows match the cross-owner recount; clones: ${clonesRows.map((c) => `${c.agent} counted ${c.counted}/${c.settled} settled`).join(', ')}; same-owner matches: ${sameOwnerMatches.map((m) => `${m.status}${m.a_move ? ` ${m.a_move}${m.b_move}` : ''}`).join(', ')}`,
        pass: ok && sameOwnerMatches.length > 0,
        tx: null,
        details: { leaderboard_check: check },
      }),
    );
    return rows;
  },
};
