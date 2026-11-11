// 8. Commitment mismatch: the ciphertext decrypts fine but its plaintext doesn't hash to `commitment`
// (sealed with salt A, committed with the commitment for salt B). The TEE gives that side F.
import { commitment, encryptPrompt, randomSalt } from '@osd/sdk';
import { row, actualOf, type Attack } from '../lib/attack.ts';
import { view } from '../lib/near.ts';
import { txFor } from '../lib/journal.ts';
import { agentId, allMatches, commitEntry, ensureBudget, loadPlan, loadState, readPrompt, saveSalt, saveState, type Season } from '../lib/season.ts';
import type { AttackResult } from '../lib/results.ts';

export const commitmentMismatch: Attack = {
  name: 'commitment-mismatch',
  kind: 'season',
  attack: 8,
  summary: 'Commit a ciphertext whose plaintext does not match the commitment → forfeit F in every match, bond lost',
  async run() {
    const st = loadState();
    if (st.season_id === null) return [];
    const sid = st.season_id;
    const s = await view<Season>('get_season', { season_id: sid });
    const a = loadPlan().agents.find((x) => x.roles.includes('mismatch'))!;
    const id = agentId(a.name);
    const rows: AttackResult[] = [];

    if (s.status === 'commit' && !st.commits[id]) {
      await ensureBudget(id, BigInt(s.entry_deposit_yocto));
      const prompt = readPrompt(a.prompt_file);
      const saltSealed = randomSalt();
      const saltClaimed = randomSalt();
      const ct = encryptPrompt(s.pubkey!, prompt, saltSealed);
      const c = commitment(prompt, saltClaimed, id); // ≠ sha256(prompt ‖ saltSealed ‖ id)
      saveSalt(id, { salt: saltClaimed, commitment: c, prompt_file: a.prompt_file });
      const o = await commitEntry(sid, id, ct, c, a.family);
      if (o.ok) st.commits[id] = { tx: o.txHash, kind: 'mismatch' };
      saveState(st);
      console.log(`mismatch commit ${id}: ${actualOf(o)} ${o.txHash}`);
    }
    if (st.commits[id]) {
      rows.push(
        row({
          id: '08a',
          attack: 8,
          script: 'commitment-mismatch',
          title: `Commit ciphertext(prompt, saltA) with commitment(prompt, saltB) as ${a.name}`,
          expected: 'accepted on chain (the contract cannot decrypt; checked in the TEE)',
          actual: 'accepted',
          pass: true,
          tx: st.commits[id].tx,
        }),
      );
    }
    if (s.status !== 'play' && s.status !== 'settled') return rows;

    const mine = (await allMatches(sid)).filter((m) => m.a === id || m.b === id);
    const done = mine.filter((m) => m.status === 'settled');
    const forfeits = done.filter((m) => (m.a === id ? m.a_move : m.b_move) === 'F');
    const fair = forfeits.every((m) => (m.a === id ? m.a_payoff === 0 && m.b_payoff === 3 : m.b_payoff === 0 && m.a_payoff === 3) && m.pool_delta === 3);
    const example = forfeits[0];
    rows.push(
      row({
        id: '08b',
        attack: 8,
        script: 'commitment-mismatch',
        title: `Mismatched entry plays its matches (${done.length}/${mine.length} settled)`,
        expected: 'every match: this side F (0), opponent 3, +3 units to the pool; no LLM call',
        actual: `${forfeits.length}/${done.length} settled matches F; payoffs 0/3 +3 pool: ${fair ? 'yes' : 'NO'}`,
        pass: done.length > 0 && forfeits.length === done.length && fair,
        tx: example ? (txFor(sid, 'play_match', example.a, example.b) ?? null) : null,
        details: { matches: mine.map((m) => ({ key: m.match_key, status: m.status, a_move: m.a_move, b_move: m.b_move, void_reason: m.void_reason })) },
      }),
    );
    if (s.status === 'settled') {
      const claim = BigInt(await view<string>('get_claimable', { season_id: sid, agent_id: id }));
      const bond = BigInt(s.params.bond_yocto);
      const unit = BigInt(s.params.unit_yocto);
      const full = await view<Season & { stake_per_agent_yocto: string }>('get_season', { season_id: sid });
      const refunded = mine.filter((m) => m.status === 'refunded').length;
      // claimable = unused stake + payoffs (all 0) + 3 units per refunded void + prize (0) + bond (withheld if forfeited)
      const withoutBond = BigInt(full.entry_deposit_yocto) - bond - BigInt(full.stake_per_agent_yocto) + 3n * unit * BigInt(refunded);
      const lb = await view<{ agent_id: string; rank: number | null; matches_counted: number }[]>('get_leaderboard', { season_id: sid });
      const me = lb.find((r) => r.agent_id === id);
      rows.push(
        row({
          id: '08c',
          attack: 8,
          script: 'commitment-mismatch',
          title: 'Settlement of the forfeiting entry',
          expected: `bond (${bond} yocto) withheld into the pool: claimable = unused stake + void refunds = ${withoutBond} yocto`,
          actual: `claimable ${claim} yocto (${claim === withoutBond ? 'no bond' : claim === withoutBond + bond ? 'BOND RETURNED' : 'other'}); rank ${me?.rank ?? 'null'}, avg ${me ? 0 : '-'}`,
          pass: claim === withoutBond,
          details: { claimable: claim.toString(), bond: bond.toString(), refunded_matches: refunded },
          tx: null,
        }),
      );
    }
    return rows;
  },
};
