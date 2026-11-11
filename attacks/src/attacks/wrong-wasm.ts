// 5. Wrong WASM with the same secrets → keystore refuses (WasmHash binding).
//
// To isolate the WasmHash accessor from the Predecessor rule, 05a is signed with the
// contract account's own key, so the predecessor IS the whitelisted contract and only the
// hash binding can refuse. 05b (control) runs the pinned WASM the same way: it succeeds,
// which is FINDING F1 (the contract account still holds a full-access key).
import { row, type Attack } from '../lib/attack.ts';
import { ATTACKER, CONTRACT, hasKey, outlayerCompleted, rpc, view } from '../lib/near.ts';
import { PROBE_WASM, config, probeOutput, requestExecution } from '../lib/outlayer.ts';
import type { AttackResult } from '../lib/results.ts';

export const F1 =
  'F1: osd contract account still has a FullAccess key. Its holder passes the keystore Predecessor rule (can run the referee against stored ciphertexts out of band: a prompt-probing oracle) and can call #[private] on_match/on_pubkey (forge results). Fix: delete the full-access key after deploy (locked contract), or move upgrades behind a DAO/multisig.';

export const wrongWasm: Attack = {
  name: 'wrong-wasm',
  kind: 'no-season',
  attack: 5,
  summary: 'Different WASM hash + the game secrets: refused by the WasmHash binding',
  async run() {
    const cfg = await config();
    const rows: AttackResult[] = [];
    const secrets = { profile: cfg.secrets_profile, account_id: cfg.secrets_owner };
    const input = { action: 'derive_pubkey', season: 1 };

    // 05a: predecessor = contract (whitelisted), wasm = attacker probe (different hash).
    const probeRow = (id: string, signer: string, title: string, o: Awaited<ReturnType<typeof requestExecution>>): AttackResult => {
      const ev = outlayerCompleted(o);
      const p = probeOutput(o.value);
      const leaked = p !== null && (p.season_seed_present || p.nearai_key_present);
      const refused = ev !== null && !ev.success;
      return row({
        id,
        attack: 5,
        script: 'wrong-wasm',
        title,
        expected: 'secret not released to a WASM whose hash ≠ WasmHash(ad40dcf4…): PROTECTED_SEASON_SEED and NEARAI_API_KEY absent (or job refused)',
        actual: refused
          ? `job refused: ${ev?.error_message}`
          : p
            ? `ran without the secret: season_seed_present=${p.season_seed_present}, nearai_key_present=${p.nearai_key_present} (predecessor ${p.predecessor}; env names: ${p.env_names.join(' ') || '–'})`
            : `unexpected output ${JSON.stringify(o.value)?.slice(0, 120)} (${o.error ?? ''})`,
        pass: refused || (p !== null && !leaked),
        finding: leaked ? 'WasmHash binding NOT enforced: game secret reached a foreign WASM' : undefined,
        tx: o.txHash,
        details: { signer, wasm_hash: PROBE_WASM.hash, wasm_upload_tx: PROBE_WASM.upload_tx, pinned_hash: cfg.wasm_hash, outlayer: ev },
      });
    };
    if (hasKey(CONTRACT)) {
      const o = await requestExecution(CONTRACT, { wasm: PROBE_WASM, input, secrets });
      rows.push(probeRow('05a', CONTRACT, 'Whitelisted predecessor (contract key) + attacker probe WASM (b6e46bab…) + game secrets_ref', o));
    }
    // 05b: outsider + wrong wasm (both rules violated).
    const o2 = await requestExecution(ATTACKER, { wasm: PROBE_WASM, input, secrets });
    rows.push(probeRow('05b', ATTACKER, 'Outsider + attacker probe WASM + game secrets_ref', o2));

    // 05c control: contract key + the pinned WASM → secrets released (proves 05a failed on the hash alone).
    if (hasKey(CONTRACT)) {
      const keys = await rpc<{ keys: { access_key: { permission: unknown } }[] }>('query', {
        request_type: 'view_access_key_list',
        finality: 'final',
        account_id: CONTRACT,
      });
      const fullAccess = keys.keys.filter((k) => k.access_key.permission === 'FullAccess').length;
      const o3 = await requestExecution(CONTRACT, { wasm: { url: cfg.wasm_url, hash: cfg.wasm_hash }, input, secrets });
      const ev3 = outlayerCompleted(o3);
      const pk = await view<string | null>('get_season_pubkey', { season_id: 1 });
      const out = JSON.stringify(o3.value ?? '');
      const derived = pk !== null && out.includes(pk);
      rows.push(
        row({
          id: '05c',
          attack: 5,
          script: 'wrong-wasm',
          title: 'Control: contract FULL-ACCESS key + pinned WASM + game secrets, signed outside the contract code',
          expected: 'secrets released (same predecessor, right hash) → shows 05a/05b got no secret because of the WasmHash binding alone',
          actual: `execution_completed success=${ev3?.success}; derived season-1 pubkey ${derived ? 'matches get_season_pubkey(1)' : 'not returned'}; contract has ${fullAccess} FullAccess key(s)`,
          pass: ev3?.success === true,
          finding: fullAccess > 0 && ev3?.success === true ? F1 : undefined,
          tx: o3.txHash,
          details: { signer: CONTRACT, full_access_keys: fullAccess, output: o3.value },
        }),
      );
    }
    return rows;
  },
};
