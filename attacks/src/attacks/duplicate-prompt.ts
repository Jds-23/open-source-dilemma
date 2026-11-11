// 7. Duplicate prompt: two agents with different owners commit byte-identical prompts.
// Commit phase: both commits are accepted (salted commitments differ, so the chain can't tell).
// After play: their match is void `duplicate_prompt` (TEE check) and refund_void returns 3 units each.
import { actions } from 'near-api-js';
import { sealPrompt } from '@osd/sdk';
import { actualOf, row, type Attack } from '../lib/attack.ts';
import { ATTACKER, CONTRACT, TGAS, send, view } from '../lib/near.ts';
import { txFor } from '../lib/journal.ts';
import { agentId, allMatches, commitEntry, ensureBudget, findMatch, loadPlan, loadState, readPrompt, saveSalt, saveState, type Season } from '../lib/season.ts';
import type { AttackResult } from '../lib/results.ts';

export const duplicatePrompt: Attack = {
  name: 'duplicate-prompt',
  kind: 'season',
  attack: 7,
  summary: 'Two owners commit the same prompt; the TEE voids their match (duplicate_prompt); refund_void refunds',
  async run() {
    const st = loadState();
    if (st.season_id === null) return [];
    const sid = st.season_id;
    const s = await view<Season>('get_season', { season_id: sid });
    const dups = loadPlan().agents.filter((a) => a.roles.includes('duplicate'));
    const [x, y] = dups.map((a) => agentId(a.name));
    const rows: AttackResult[] = [];

    if (s.status === 'commit') {
      for (const a of dups) {
        const id = agentId(a.name);
        if (st.commits[id]) continue;
        await ensureBudget(id, BigInt(s.entry_deposit_yocto));
        const prompt = readPrompt(a.prompt_file); // same file → byte-identical prompt
        const sealed = sealPrompt(s.pubkey!, prompt, id);
        saveSalt(id, { salt: sealed.salt, commitment: sealed.commitment, prompt_file: a.prompt_file });
        const o = await commitEntry(sid, id, sealed.ciphertext_hex, sealed.commitment, a.family);
        if (o.ok) st.commits[id] = { tx: o.txHash, kind: 'duplicate' };
        saveState(st);
        console.log(`duplicate commit ${id}: ${actualOf(o)} ${o.txHash}`);
      }
    }
    const es = await view<{ agent_id: string; owner: string; commitment: string }[]>('get_entries', { season_id: sid, limit: 200 });
    const ex = es.find((e) => e.agent_id === x);
    const ey = es.find((e) => e.agent_id === y);
    if (ex && ey) {
      rows.push(
        row({
          id: '07a',
          attack: 7,
          script: 'duplicate-prompt',
          title: `Commit byte-identical prompt from 2 owners (${ex.owner.split('.')[0]}, ${ey.owner.split('.')[0]})`,
          expected: 'both commits accepted (salted commitments differ; no on-chain duplicate check by design, INTERFACE §5)',
          actual: `accepted; commitments ${ex.commitment.slice(0, 8)}… ≠ ${ey.commitment.slice(0, 8)}…`,
          pass: ex.commitment !== ey.commitment,
          tx: st.commits[y]?.tx ?? st.commits[x]?.tx,
          details: { commits: { [x]: st.commits[x]?.tx, [y]: st.commits[y]?.tx } },
        }),
      );
    }
    if (s.status !== 'play' && s.status !== 'settled') return rows;

    const m = findMatch(await allMatches(sid), x, y);
    if (!m) return rows;
    const playTx = txFor(sid, 'play_match', m.a, m.b);
    rows.push(
      row({
        id: '07b',
        attack: 7,
        script: 'duplicate-prompt',
        title: 'Duplicate pair meets: referee detects byte-equal prompts',
        expected: 'match void, void_reason duplicate_prompt, no LLM call, no payoffs',
        actual: `status ${m.status}, void_reason ${m.void_reason ?? '–'}, moves ${m.a_move ?? '-'}/${m.b_move ?? '-'}`,
        pass: (m.status === 'void' || m.status === 'refunded') && m.void_reason === 'duplicate_prompt',
        tx: playTx ?? null,
        details: { match_key: m.match_key },
      }),
    );
    if (m.status === 'scheduled' || m.status === 'pending') return rows;

    let refundTx = txFor(sid, 'refund_void', m.a, m.b);
    let refundActual = refundTx ? 'refund_void sent by keeper' : '';
    if (m.status === 'void') {
      const o = await send(ATTACKER, CONTRACT, [actions.functionCall('refund_void', { season_id: sid, a: m.a, b: m.b }, 30n * TGAS, 0n)]);
      refundTx = o.txHash;
      refundActual = `refund_void: ${actualOf(o)}`;
    }
    const after = findMatch(await allMatches(sid), x, y)!;
    const unit = BigInt(s.params.unit_yocto);
    rows.push(
      row({
        id: '07c',
        attack: 7,
        script: 'duplicate-prompt',
        title: 'refund_void on the duplicate_prompt match',
        expected: `match → refunded; 3 units (${(3n * unit).toString()} yocto) credited to each side's claimable`,
        actual: `${refundActual}; status now ${after.status}`,
        pass: after.status === 'refunded',
        tx: refundTx ?? null,
      }),
    );
    // A second refund must fail (no double refund).
    const o2 = await send(ATTACKER, CONTRACT, [actions.functionCall('refund_void', { season_id: sid, a: m.a, b: m.b }, 30n * TGAS, 0n)]);
    rows.push(
      row({
        id: '07d',
        attack: 7,
        script: 'duplicate-prompt',
        title: 'Second refund_void on the same match (double refund)',
        expected: 'refused: "match not void"',
        actual: actualOf(o2),
        pass: !o2.ok && /match not void/.test(o2.error ?? ''),
        tx: o2.txHash,
      }),
    );
    return rows;
  },
};
