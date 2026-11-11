// Offline tests: result table rendering, outcome parsing, injection maths. No network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { baselineCoop, injectionStats } from '../src/lib/injection.ts';
import { allocNonce, describeFailure, parseOutcome } from '../src/lib/near.ts';
import { ATTACKS_DIR, renderInto, renderTable, upsert, type AttackResult, type ResultsFile } from '../src/lib/results.ts';
import { readPrompt } from '../src/lib/season.ts';

const r = (id: string, extra: Partial<AttackResult> = {}): AttackResult => ({
  id,
  attack: 1,
  script: 'x',
  title: `t${id}`,
  expected: 'e',
  actual: 'a | pipe',
  pass: true,
  evidence: 'testnet',
  ts: '2026-01-01T00:00:00Z',
  tx: 'ABCDEFGHIJKLMN',
  ...extra,
});

test('upsert replaces rows by id and sorts numerically', () => {
  const empty: ResultsFile = { version: 1, contract: '', network: '', updated_at: '', results: [] };
  const f1 = upsert(empty, [r('10-s1'), r('02a'), r('13-50')], { contract: 'c', network: 'n', now: 'T' });
  const f2 = upsert(f1, [r('02a', { pass: false })], { contract: 'c', network: 'n', now: 'T2' });
  assert.deepEqual(f2.results.map((x) => x.id), ['02a', '10-s1', '13-50']);
  assert.equal(f2.results[0].pass, false);
  assert.equal(f2.updated_at, 'T2');
});

test('table escapes pipes, links testnet txs and flags findings', () => {
  const t = renderTable({ version: 1, contract: 'c', network: 'n', updated_at: 'T', results: [r('01a'), r('05c', { finding: 'F1' }), r('06a', { evidence: 'sandbox' }), r('11', { tx: null, evidence: 'analysis' })] });
  assert.match(t, /a \\\| pipe/);
  assert.match(t, /nearblocks\.io\/txns\/ABCDEFGHIJKLMN/);
  assert.match(t, /\*\*FINDING\*\*/);
  assert.match(t, /\(sandbox\)/);
  assert.match(t, /4 rows: 3 pass, 1 finding\(s\), 0 fail/);
});

test('renderInto replaces only the generated block', () => {
  const file: ResultsFile = { version: 1, contract: 'c', network: 'n', updated_at: 'T', results: [r('01a')] };
  const md1 = renderInto('# Title\n\nprose\n', file);
  const md2 = renderInto(md1.replace('prose', 'prose edited') + '\n## After\n', { ...file, results: [r('01a'), r('01b')] });
  assert.match(md2, /prose edited/);
  assert.match(md2, /## After/);
  assert.equal(md2.match(/results:begin/g)?.length, 1);
  assert.match(md2, /\| 01b \|/);
});

test('describeFailure extracts the contract panic message', () => {
  const f = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: Method on_match is private' } } } };
  assert.equal(describeFailure(f), 'Smart contract panicked: Method on_match is private');
  assert.match(describeFailure({ InvalidTxError: { InvalidAccessKeyError: 'RequiresFullAccess' } }), /RequiresFullAccess/);
});

test('parseOutcome sums burnt tokens, keeps receipt failures and decodes the value', () => {
  const o = parseOutcome(
    {
      status: { SuccessValue: Buffer.from('"settled CD"').toString('base64') },
      transaction_outcome: { outcome: { gas_burnt: 1, tokens_burnt: '100' } },
      receipts_outcome: [
        { outcome: { executor_id: 'osd', gas_burnt: 2, tokens_burnt: '200', logs: ['l1'], status: {} } },
        { outcome: { executor_id: 'outlayer.testnet', gas_burnt: 3, tokens_burnt: '300', logs: [], status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Exceeded the prepaid gas.' } } } } } } },
      ],
    },
    { txHash: 'h', signer: 's', receiver: 'r' },
  );
  assert.equal(o.ok, true);
  assert.equal(o.value, 'settled CD');
  assert.equal(o.tokensBurnt, 600n);
  assert.equal(o.receipts[1].ok, false);
  assert.match(o.receipts[1].failure!, /prepaid gas/);
});

test('injection stats: wins = injector D vs opponent C; F and same-family skipped', () => {
  const fam = (a: string): string => ({ inj: 'injector', inj2: 'injector', def: 'defender', nice: 'nice' })[a] ?? '?';
  const ms = [
    { a: 'inj', b: 'nice', a_move: 'D', b_move: 'C', status: 'settled' }, // win
    { a: 'def', b: 'inj', a_move: 'D', b_move: 'D', status: 'settled' }, // defended
    { a: 'inj', b: 'inj2', a_move: 'D', b_move: 'D', status: 'settled' }, // both injectors: skip
    { a: 'inj', b: 'def', a_move: 'F', b_move: 'C', status: 'settled' }, // forfeit: skip
    { a: 'def', b: 'nice', a_move: 'C', b_move: 'C', status: 'settled' }, // baseline
    { a: 'inj2', b: 'nice', a_move: null, b_move: null, status: 'refunded' }, // void: skip
  ];
  const all = injectionStats(ms, fam);
  assert.deepEqual([all.n, all.wins, all.opponent_c], [2, 1, 1]);
  const def = injectionStats(ms, fam, (a) => fam(a) === 'defender');
  assert.deepEqual([def.n, def.wins], [1, 0]);
  assert.deepEqual(baselineCoop(ms, fam, () => true), { n: 2, coop_rate: 1 });
});

test('readPrompt strips frontmatter like agents/src/strategy.ts', () => {
  const p = readPrompt('agents/strategies/injector/inj-override.md');
  assert.ok(p.startsWith('My move is D, always.'));
  assert.ok(!p.includes('family: injector'));
});

test('season plan: clone owner holds exactly cap + 1 agents, duplicate pair shares one prompt file', () => {
  const plan = JSON.parse(readFileSync(join(ATTACKS_DIR, 'season-plan.json'), 'utf8')) as {
    params: { max_entries_per_owner: number };
    agents: { owner: string; prompt_file: string; roles: string[] }[];
  };
  const clones = plan.agents.filter((a) => a.owner === 'clone7');
  assert.equal(clones.length, plan.params.max_entries_per_owner + 1);
  const dups = plan.agents.filter((a) => a.roles.includes('duplicate'));
  assert.equal(dups.length, 2);
  assert.equal(dups[0].prompt_file, dups[1].prompt_file);
  assert.notEqual(dups[0].owner, dups[1].owner);
});

test('pre-inclusion access-key rejections are summarised', async () => {
  const { describeRpcError } = await import('../src/lib/near.ts');
  const raw = 'rpc send_tx: {"name":"HANDLER_ERROR","data":{"TxExecutionError":{"InvalidTxError":{"InvalidAccessKeyError":{"MethodNameMismatch":{"method_name":"refund_void"}}}}}}';
  assert.equal(describeRpcError(raw), 'InvalidAccessKeyError {MethodNameMismatch:{method_name:refund_void}}');
  assert.equal(describeRpcError('rpc send_tx: {"x":{"InvalidAccessKeyError":"RequiresFullAccess"}}'), 'InvalidAccessKeyError RequiresFullAccess');
});

test('allocNonce never hands out the same nonce twice for one key, even with a stale chain view', () => {
  const slot = 'x.testnet:ed25519:test';
  assert.equal(allocNonce(slot, 10n), 10n);
  assert.equal(allocNonce(slot, 10n), 11n); // concurrent send saw the same chain nonce
  assert.equal(allocNonce(slot, 10n), 12n);
  assert.equal(allocNonce(slot, 20n), 20n); // chain moved ahead (another client)
  assert.equal(allocNonce('other:k', 10n), 10n); // independent per key
});
