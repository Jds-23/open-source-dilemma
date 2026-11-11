// 5c follow-up (F1 fix, interfaces-v5). The contract account's own key passes `#[private]` and the
// OutLayer keystore Predecessor rule.
//  05c-b: before seal, a direct on_match signed with that key must now be refused ("not a callback":
//         a genuine callback has exactly one promise result, a direct call has none).
//  05c-after-seal: once the owner ran `seal`, the account has zero keys, so the 05c OutLayer call
//         (and anything else) cannot be signed as the contract. Recorded only when is_sealed() is true.
import { actions } from 'near-api-js';
import { actualOf, row, type Attack } from '../lib/attack.ts';
import { CONTRACT, TGAS, hasKey, rpc, send, view, type TxOutcome } from '../lib/near.ts';
import { config, requestExecution } from '../lib/outlayer.ts';
import type { AttackResult } from '../lib/results.ts';
import type { Match } from '../lib/season.ts';

async function keyList(): Promise<string[]> {
  const r = await rpc<{ keys: { public_key: string }[] }>('query', {
    request_type: 'view_access_key_list',
    finality: 'final',
    account_id: CONTRACT,
  });
  return r.keys.map((k) => k.public_key);
}

/** Signing fails locally once the key is gone (nonce lookup: access key not found); report it as a rejection. */
async function trySend(f: () => Promise<TxOutcome>): Promise<TxOutcome> {
  try {
    return await f();
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    return { txHash: '', included: false, ok: false, error: `cannot sign: ${msg.slice(0, 160)}`, logs: [], receipts: [], tokensBurnt: 0n, signer: CONTRACT, receiver: '' };
  }
}

export const contractKey: Attack = {
  name: 'contract-key',
  kind: 'no-season',
  attack: 5,
  summary: 'Contract account key: direct #[private] callback refused; after seal nothing can be signed as the contract',
  async run() {
    const rows: AttackResult[] = [];
    if (!hasKey(CONTRACT)) {
      console.log(`no local key file for ${CONTRACT}; nothing to sign with`);
      return rows;
    }
    const sealed = await view<boolean>('is_sealed').catch(() => null);
    const keys = await keyList();
    const [m] = await view<Match[]>('get_matches', { season_id: 1, limit: 1 });
    const before = JSON.stringify(m);

    // 05c-b: direct on_match from the contract's own key.
    const o = await trySend(() => send(CONTRACT, CONTRACT, [actions.functionCall('on_match', { season_id: 1, a: m.a, b: m.b }, 30n * TGAS, 0n)]));
    const after = JSON.stringify((await view<Match[]>('get_matches', { season_id: 1, limit: 1 }))[0]);
    const refusedCb = !o.ok && /not a callback/.test(o.error ?? '');
    const noKey = sealed === true && keys.length === 0 && !o.included;
    rows.push(
      row({
        id: '05c-b',
        attack: 5,
        script: 'contract-key',
        title: 'Contract FULL-ACCESS key calls #[private] on_match directly (passes the predecessor check)',
        expected: 'refused: "not a callback" (0 promise results), or unsignable after seal; match unchanged',
        actual: `${actualOf(o)}; match unchanged: ${before === after}; contract keys: ${keys.length}; is_sealed: ${sealed}`,
        pass: (refusedCb || noKey) && before === after,
        tx: o.txHash || null,
        details: { signer: CONTRACT, args: { season_id: 1, a: m.a, b: m.b }, keys, is_sealed: sealed },
      }),
    );

    // 05c-after-seal: zero keys, the 05c OutLayer run cannot be signed.
    if (sealed !== true) {
      console.log(`05c-after-seal: ${CONTRACT} is not sealed yet (is_sealed=${sealed}, ${keys.length} key(s)); row recorded after \`ops/scripts/seal.sh --execute\``);
      return rows;
    }
    const cfg = await config();
    const o2 = await trySend(() =>
      requestExecution(CONTRACT, {
        wasm: { url: cfg.wasm_url, hash: cfg.wasm_hash },
        input: { action: 'derive_pubkey', season: 1 },
        secrets: { profile: cfg.secrets_profile, account_id: cfg.secrets_owner },
      }),
    );
    rows.push(
      row({
        id: '05c-after-seal',
        attack: 5,
        script: 'contract-key',
        title: 'After seal: contract key + pinned WASM + game secrets (the 05c keystore bypass)',
        expected: 'view_access_key_list = [] and is_sealed = true; the OutLayer request cannot be signed as the contract (no tx)',
        actual: `keys: ${JSON.stringify(keys)}; is_sealed: ${sealed}; ${actualOf(o2)}`,
        pass: keys.length === 0 && !o2.included,
        tx: null,
        details: { signer: CONTRACT, keys, is_sealed: sealed },
      }),
    );
    return rows;
  },
};
