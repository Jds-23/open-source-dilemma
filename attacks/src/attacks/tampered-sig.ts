// 6. Tampered NEAR AI signature (sandbox evidence): wraps `cargo test` in attacks/sandbox.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { row, type Attack } from '../lib/attack.ts';
import { ATTACKS_DIR, type AttackResult } from '../lib/results.ts';

export const tamperedSig: Attack = {
  name: 'tampered-sig',
  kind: 'no-season',
  attack: 6,
  summary: 'Tampered NEAR AI signature → sig flag false, match still settles (near-workspaces sandbox, mock OutLayer)',
  async run() {
    const dir = join(ATTACKS_DIR, 'sandbox');
    // Async (not spawnSync) so `run no-season` keeps the testnet attacks going while cargo runs.
    const r = await new Promise<{ status: number | null; out: string; error?: Error }>((resolve) => {
      const p = spawn('cargo', ['test', '--locked', '--', '--nocapture'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout.on('data', (d: Buffer) => (out += d.toString()));
      p.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
      p.on('error', (error) => resolve({ status: null, out, error }));
      p.on('close', (status) => resolve({ status, out: out || err }));
    });
    const out = r.out;
    const rows: AttackResult[] = [];
    for (const line of out.split('\n')) {
      const m = /^ATTACK_RESULT (\{.*\})$/.exec(line.trim());
      if (!m) continue;
      const j = JSON.parse(m[1]) as { id: string; title: string; expected: string; actual: string; pass: boolean; tx: string };
      rows.push(row({ id: j.id, attack: 6, script: 'tampered-sig', title: j.title, expected: j.expected, actual: j.actual, pass: j.pass, tx: j.tx, evidence: 'sandbox' }));
    }
    if (rows.length === 0) {
      rows.push(
        row({
          id: '06a',
          attack: 6,
          script: 'tampered-sig',
          title: 'Tampered NEAR AI signature (sandbox)',
          expected: 'sig flags false; match settles',
          actual: `sandbox test did not run (exit ${r.status}): ${(r.error?.message ?? out.slice(-300)).replace(/\s+/g, ' ')}`,
          pass: false,
          evidence: 'sandbox',
          tx: null,
        }),
      );
    }
    return rows;
  },
};
