// 4. Outsider runs the referee job directly with the game's secrets_ref → keystore refuses (Predecessor).
import { row, type Attack } from '../lib/attack.ts';
import { ATTACKER, outlayerCompleted } from '../lib/near.ts';
import { config, probeInput, requestExecution } from '../lib/outlayer.ts';
import type { AttackResult } from '../lib/results.ts';

export const outsiderOutlayer: Attack = {
  name: 'outsider-outlayer',
  kind: 'no-season',
  attack: 4,
  summary: 'Outsider calls outlayer.testnet request_execution with the pinned WASM + secrets_ref (prompt probe)',
  async run() {
    const cfg = await config();
    const input = await probeInput(1);
    const rows: AttackResult[] = [];

    const o = await requestExecution(ATTACKER, {
      wasm: { url: cfg.wasm_url, hash: cfg.wasm_hash },
      input,
      secrets: { profile: cfg.secrets_profile, account_id: cfg.secrets_owner },
    });
    const ev = outlayerCompleted(o);
    const denied = ev !== null && !ev.success && /access denied|access condition|predecessor|not allowed/i.test(ev.error_message ?? '');
    rows.push(
      row({
        id: '04a',
        attack: 4,
        script: 'outsider-outlayer',
        title: `Outsider runs pinned referee with secrets_ref ${cfg.secrets_profile} on two sealed season-1 entries`,
        expected: 'OutLayer keystore refuses the secret (Predecessor whitelist = [contract]); no output',
        actual: ev ? `execution_completed success=${ev.success}: ${ev.error_message ?? '(no error)'}` : `no execution_completed event (${o.error ?? 'tx ok'})`,
        pass: denied,
        tx: o.txHash,
        details: { signer: ATTACKER, wasm_hash: cfg.wasm_hash, match_key: input.match_key, charged: ev?.payment_charged, tx_value: o.value },
      }),
    );

    // Defence in depth: without secrets the referee itself refuses a non-contract predecessor.
    const o2 = await requestExecution(ATTACKER, { wasm: { url: cfg.wasm_url, hash: cfg.wasm_hash }, input, secrets: null });
    const ev2 = outlayerCompleted(o2);
    const out = JSON.stringify(o2.value ?? '') + o2.logs.join(' ');
    const wasmRefused = /predecessor_not_allowed/.test(out);
    rows.push(
      row({
        id: '04b',
        attack: 4,
        script: 'outsider-outlayer',
        title: 'Outsider runs pinned referee without secrets (WASM-level predecessor check)',
        expected: 'referee returns error predecessor_not_allowed (no decryption, no LLM call)',
        actual: `execution_completed success=${ev2?.success}; output: ${JSON.stringify(o2.value ?? null).slice(0, 160)}`,
        pass: wasmRefused,
        tx: o2.txHash,
        details: { signer: ATTACKER, charged: ev2?.payment_charged, error_message: ev2?.error_message },
      }),
    );
    return rows;
  },
};
