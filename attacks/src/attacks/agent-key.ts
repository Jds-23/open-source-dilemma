// 3. Agent function-call key: everything outside `commit`/`claim` on the contract must fail.
import { actions, KeyPair } from 'near-api-js';
import { actualOf, row, type Attack } from '../lib/attack.ts';
import { ATTACKER, CONTRACT, OUTLAYER, TGAS, milliNear, rpc, send, view } from '../lib/near.ts';
import { agentId } from '../lib/season.ts';
import type { AttackResult } from '../lib/results.ts';

/** Agent whose FC key (from register_agent) is in ~/.near-credentials. */
const AGENT = agentId(process.env.ATK_AGENT ?? 'inj-override');

export const agentKey: Attack = {
  name: 'agent-key',
  kind: 'no-season',
  attack: 3,
  summary: 'Signed with a real agent FC key: transfer, add_key, delete_account, other method, other receiver, deposit',
  async run() {
    const keys = await rpc<{ keys: { public_key: string; access_key: { permission: unknown } }[] }>('query', {
      request_type: 'view_access_key_list',
      finality: 'final',
      account_id: AGENT,
    });
    const perm = keys.keys.map((k) => k.access_key.permission);
    const fresh = KeyPair.fromRandom('ed25519').getPublicKey();
    const cases: { id: string; title: string; acts: Parameters<typeof send>[2]; receiver: string; expect: RegExp; expected: string }[] = [
      { id: '03a', title: 'FC key: Transfer 0.1 NEAR out of the agent account', receiver: ATTACKER, acts: [actions.transfer(milliNear(100))], expect: /RequiresFullAccess|InvalidAccessKey/, expected: 'rejected: RequiresFullAccess' },
      { id: '03b', title: 'FC key: AddKey (full access) to the agent account', receiver: AGENT, acts: [actions.addFullAccessKey(fresh)], expect: /RequiresFullAccess|InvalidAccessKey/, expected: 'rejected: RequiresFullAccess' },
      { id: '03c', title: 'FC key: DeleteAccount (beneficiary = attacker)', receiver: AGENT, acts: [actions.deleteAccount(ATTACKER)], expect: /RequiresFullAccess|InvalidAccessKey/, expected: 'rejected: RequiresFullAccess' },
      { id: '03d', title: 'FC key: call non-allowed method refund_void on the contract', receiver: CONTRACT, acts: [actions.functionCall('refund_void', { season_id: 1, a: 'x', b: 'y' }, 30n * TGAS, 0n)], expect: /MethodNameMismatch/, expected: 'rejected: MethodNameMismatch' },
      { id: '03e', title: 'FC key: allowed method name `commit` on another receiver (outlayer.testnet)', receiver: OUTLAYER, acts: [actions.functionCall('commit', {}, 30n * TGAS, 0n)], expect: /ReceiverMismatch/, expected: 'rejected: ReceiverMismatch' },
      { id: '03f', title: 'FC key: `commit` with 1 yoctoNEAR attached', receiver: CONTRACT, acts: [actions.functionCall('commit', { season_id: 1, agent_id: AGENT, ciphertext_hex: '00', commitment: '00'.repeat(32), family: 'x', parent: null }, 30n * TGAS, 1n)], expect: /DepositWithFunctionCall|deposit/i, expected: 'rejected: DepositWithFunctionCall' },
    ];
    const rows: AttackResult[] = [];
    for (const c of cases) {
      const o = await send(AGENT, c.receiver, c.acts);
      rows.push(
        row({
          id: c.id,
          attack: 3,
          script: 'agent-key',
          title: c.title,
          expected: c.expected,
          actual: actualOf(o),
          pass: !o.ok && c.expect.test(o.error ?? ''),
          tx: o.included ? o.txHash : null,
          details: { signer: AGENT, key_permission: perm, signed_tx_hash: o.txHash, included: o.included },
        }),
      );
    }
    // Positive control: the same key may call `claim` (allowed method, no deposit).
    const claimable = await view<string>('get_claimable', { season_id: 1, agent_id: AGENT });
    const o = await send(AGENT, CONTRACT, [actions.functionCall('claim', { season_id: 1, agent_id: AGENT }, 30n * TGAS, 0n)]);
    const keyAccepted = o.included; // a contract refusal ("nothing claimable") still proves the key allowed the call
    rows.push(
      row({
        id: '03g',
        attack: 3,
        script: 'agent-key',
        title: 'Control: FC key calls allowed `claim` (season 1)',
        expected: 'accepted by the key (claimable → budget, or contract says "nothing claimable")',
        actual: `${actualOf(o)} (claimable before: ${claimable})`,
        pass: keyAccepted && (o.ok || /nothing claimable/.test(o.error ?? '')),
        tx: o.txHash,
        details: { signer: AGENT },
      }),
    );
    return rows;
  },
};
