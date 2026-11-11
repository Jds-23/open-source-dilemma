// 11. Withholding (refusing to reveal after seeing the opponent): not applicable with OutLayer sealing.
import { row, type Attack } from '../lib/attack.ts';
import { view } from '../lib/near.ts';

export const withholding: Attack = {
  name: 'withholding',
  kind: 'no-season',
  attack: 11,
  summary: 'Reveal-withholding: n/a (no reveal step); documented',
  async run() {
    // Evidence: season-1 entries carry the full ciphertext; the referee decrypts it inside the TEE.
    const [e] = await view<{ agent_id: string; ciphertext_hex: string; commitment: string }[]>('get_entries', { season_id: 1, limit: 1 });
    return [
      row({
        id: '11',
        attack: 11,
        script: 'withholding',
        title: 'Withhold the reveal after seeing the opponent (classic commit-reveal attack)',
        expected: 'n/a: there is no reveal step to withhold',
        actual: `n/a. commit stores the ECIES ciphertext itself (season 1 entry ${e.agent_id.split('.')[0]}: ${e.ciphertext_hex.length / 2} B on chain); only the TEE (season key from PROTECTED_SEASON_SEED) decrypts it, at play time, without the player. Nothing to withhold after commit; the commit is final (no overwrite). The nearest levers: commit garbage → F + bond lost (attack 8); refuse to enter → no stake; void a match by starving play_match gas → see 13.`,
        pass: true,
        evidence: 'analysis',
        tx: null,
      }),
    ];
  },
};
