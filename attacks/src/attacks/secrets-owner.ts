// 14. Secrets owner (interfaces-v6). The OutLayer keystore keys every secrets row by
// (accessor, profile, owner) where owner = the predecessor of `store_secrets`; only that account can
// re-store, re-scope (`update_access`) or delete it. If the season profile is owned by a person, that
// person keeps control of the season seed after seal (add themselves to the Predecessor whitelist and
// probe prompts, or plant a known seed). Fix: the profile is stored by the contract account itself and
// the config points at it (`set_secrets`, refused after seal), so seal also freezes the secrets.
//  14a: the previous (human) secrets owner tries update_access on the contract's profile → the keystore
//       resolves the row under the CALLER and finds nothing; the contract-owned row is unchanged.
//  14b: live check: get_config().secrets_owner == contract and the keystore lists the profile under it
//       (WasmHash + Predecessor[contract]); after seal no key can sign as the owner (immutable).
import { actions } from 'near-api-js';
import { actualOf, refusedWith, row, type Attack } from '../lib/attack.ts';
import { CONTRACT, OUTLAYER, PARENT, TGAS, hasKey, rpc, send, view } from '../lib/near.ts';
import { config } from '../lib/outlayer.ts';
import type { AttackResult } from '../lib/results.ts';

interface SecretRow {
  accessor: { WasmHash?: { hash: string } } & Record<string, unknown>;
  profile: string;
  updated_at: number;
  access: unknown;
}

async function rows(owner: string): Promise<SecretRow[]> {
  return view<SecretRow[]>('list_user_secrets', { account_id: owner }, OUTLAYER);
}

async function keyCount(): Promise<number> {
  const r = await rpc<{ keys: unknown[] }>('query', { request_type: 'view_access_key_list', finality: 'final', account_id: CONTRACT });
  return r.keys.length;
}

const isRow = (profile: string, hash: string) => (r: SecretRow) => r.profile === profile && r.accessor.WasmHash?.hash === hash;

export const secretsOwner: Attack = {
  name: 'secrets-owner',
  kind: 'no-season',
  attack: 14,
  summary: 'Season secrets owned by the contract: no other account can modify the profile; frozen by seal',
  async run() {
    const out: AttackResult[] = [];
    const cfg = await config();
    const [sealed, keys] = await Promise.all([view<boolean>('is_sealed').catch(() => null), keyCount()]);
    const own = await rows(cfg.secrets_owner);
    const target = own.find(isRow(cfg.secrets_profile, cfg.wasm_hash));
    const whitelist = JSON.stringify(target?.access ?? null);
    const scoped = whitelist === JSON.stringify({ Predecessor: { condition: { Whitelist: { accounts: [CONTRACT] } } } });

    // 14a: previous human owner tries to re-scope the contract's profile.
    const previous = PARENT;
    if (cfg.secrets_owner === CONTRACT && hasKey(previous)) {
      const mine = await rows(previous);
      if (mine.some(isRow(cfg.secrets_profile, cfg.wasm_hash))) {
        console.log(`14a skipped: ${previous} owns its own row ${cfg.secrets_profile}; the call would act on that row`);
      } else {
        const o = await send(previous, OUTLAYER, [
          actions.functionCall(
            'update_access',
            { accessor: { WasmHash: { hash: cfg.wasm_hash } }, profile: cfg.secrets_profile, new_access: 'AllowAll' },
            30n * TGAS,
            0n,
          ),
        ]);
        const after = (await rows(CONTRACT)).find(isRow(cfg.secrets_profile, cfg.wasm_hash));
        const unchanged = !!target && !!after && JSON.stringify(after) === JSON.stringify(target);
        out.push(
          row({
            id: '14a',
            attack: 14,
            script: 'secrets-owner',
            title: `secrets-owner: previous secrets owner ${previous} calls keystore update_access(AllowAll) on the contract's profile ${cfg.secrets_profile}`,
            expected: 'refused ("Secrets not found": rows are keyed by the caller); the contract-owned row is unchanged',
            actual: `${actualOf(o)}; contract-owned row unchanged: ${unchanged}`,
            pass: refusedWith(o, /Secrets not found/) && unchanged,
            tx: o.txHash || null,
            details: { signer: previous, owner: CONTRACT, profile: cfg.secrets_profile },
          }),
        );
      }
    }

    // 14b: the config and keystore state that makes it hold.
    const ownerOk = cfg.secrets_owner === CONTRACT;
    const frozen = sealed === true && keys === 0;
    out.push(
      row({
        id: '14b',
        attack: 14,
        script: 'secrets-owner',
        title: 'secrets-owner: who can modify the season secrets profile after seal',
        expected: `get_config().secrets_owner = ${CONTRACT}; keystore row WasmHash(${cfg.wasm_hash.slice(0, 8)}…) + Predecessor[${CONTRACT}] under it; after seal (0 keys) no account can sign as the owner, so nobody can re-store, re-scope or delete it (OutLayer operator trusted)`,
        actual:
          `secrets ref ${cfg.secrets_owner}/${cfg.secrets_profile}; row present: ${!!target}; Predecessor[contract] only: ${scoped}; ` +
          `contract keys: ${keys}; is_sealed: ${sealed}; ` +
          (frozen ? 'immutable: nothing can sign as the owner' : `not sealed yet: the contract key can still modify it until seal`),
        pass: ownerOk && !!target && scoped,
        finding: ownerOk ? undefined : `secrets owner ${cfg.secrets_owner} is not the contract: it keeps control of the season secrets after seal`,
        tx: null,
        details: { secrets_owner: cfg.secrets_owner, profile: cfg.secrets_profile, row: target ?? null, keys, is_sealed: sealed },
      }),
    );
    return out;
  },
};
