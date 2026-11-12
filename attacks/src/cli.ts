// `pnpm --filter @osd/attacks run no-season` (parallel) / `run season` / `run <attack>` / `run all` / `run render` / `run spend`.
// Each attack signs real testnet transactions (keys from ~/.near-credentials) and
// records expected vs actual + tx hash into results.json and the RESULTS.md table.
import { agentKey } from './attacks/agent-key.ts';
import { cloneFarm } from './attacks/clone-farm.ts';
import { contractKey } from './attacks/contract-key.ts';
import { commitmentMismatch } from './attacks/commitment-mismatch.ts';
import { duplicatePrompt } from './attacks/duplicate-prompt.ts';
import { f2LowGas } from './attacks/f2-low-gas.ts';
import { forgedCallback } from './attacks/forged-callback.ts';
import { injection } from './attacks/injection.ts';
import { lowGasPlay } from './attacks/low-gas-play.ts';
import { outsiderCalls } from './attacks/outsider-calls.ts';
import { outsiderOutlayer } from './attacks/outsider-outlayer.ts';
import { replayAttack } from './attacks/replay.ts';
import { secretsOwner } from './attacks/secrets-owner.ts';
import { tamperedSig } from './attacks/tampered-sig.ts';
import { withholding } from './attacks/withholding.ts';
import { wrongWasm } from './attacks/wrong-wasm.ts';
import type { Attack, RunCtx } from './lib/attack.ts';
import { ATTACKER, CONTRACT, NETWORK, balance, milliNear, view } from './lib/near.ts';
import { loadResults, printRows, save, type AttackResult } from './lib/results.ts';
import { loadState, type Season } from './lib/season.ts';
import { spend } from './spend.ts';

/** In run-all order: chain-independent first, then the attack-season ones. */
export const ATTACKS: Attack[] = [
  forgedCallback,
  replayAttack,
  agentKey,
  outsiderOutlayer,
  wrongWasm,
  contractKey,
  tamperedSig,
  duplicatePrompt,
  commitmentMismatch,
  cloneFarm,
  injection,
  withholding,
  outsiderCalls,
  lowGasPlay,
  f2LowGas,
  secretsOwner,
];

async function runOne(a: Attack, ctx: RunCtx = {}): Promise<AttackResult[]> {
  console.log(`\n=== ${a.attack}. ${a.name}: ${a.summary}`);
  const rows = await a.run(ctx);
  if (rows.length === 0) console.log('(nothing to record in the current season phase)');
  printRows(rows);
  return rows;
}

const record = (rows: AttackResult[]): void => {
  if (rows.length) save(rows, { contract: CONTRACT, network: NETWORK });
};

/** Every attack that needs no live season, concurrently (send() allocates nonces per key). */
async function noSeason(): Promise<void> {
  const list = ATTACKS.filter((a) => a.kind !== 'season');
  // Concurrent txs each reserve prepaid gas at the pessimistic gas price (300 TGas ≈ 0.03+ NEAR) plus deposits;
  // with too little balance some are rejected before inclusion (NotEnoughBalance), which proves nothing.
  const bal = (await balance(ATTACKER)) ?? 0n;
  if (bal < milliNear(800)) console.warn(`warning: ${ATTACKER} has ${Number(bal / 10n ** 21n) / 1000} NEAR; parallel run wants >= 0.8 NEAR`);
  const t0 = Date.now();
  const settled = await Promise.allSettled(
    list.map(async (a) => {
      const t = Date.now();
      const rows = await a.run({ noSeason: true });
      console.log(`[${a.name}] ${rows.length} row(s) in ${((Date.now() - t) / 1000).toFixed(0)} s`);
      return rows;
    }),
  );
  const rows = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  settled.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`[${list[i].name}] FAILED: ${(r.reason as Error)?.stack ?? r.reason}`);
  });
  printRows(rows);
  record(rows);
  console.log(`\nno-season: ${rows.length} rows, ${rows.filter((r) => r.pass).length} pass, ${((Date.now() - t0) / 1000).toFixed(0)} s wall`);
  if (settled.some((r) => r.status === 'rejected')) process.exit(1);
}

/** Attacks bound to the live attack season (phase-aware; see season-ctl). */
async function season(): Promise<void> {
  const sid = loadState().season_id;
  const s = sid === null ? null : await view<Season | null>('get_season', { season_id: sid });
  if (!s || (s.status !== 'commit' && s.status !== 'play' && s.status !== 'settled')) {
    console.log(`no attack season to run against (state season ${sid ?? '–'}: ${s?.status ?? 'none'}); open one with \`run season-ctl open\` on the fast-attack preset`);
    return;
  }
  const skip = new Set((process.env.ATK_SKIP ?? 'low-gas-play').split(',').filter(Boolean));
  for (const a of ATTACKS) if (a.kind !== 'no-season' && !skip.has(a.name)) record(await runOne(a));
}

async function main(): Promise<void> {
  const name = process.argv[2];
  if (name === 'render') {
    save([], { contract: CONTRACT, network: NETWORK });
    console.log(`rendered ${loadResults().results.length} rows`);
    return;
  }
  if (name === 'spend') return spend(process.argv[3], process.argv[4]);
  if (name === 'no-season') return noSeason();
  if (name === 'season') return season();
  if (name === 'all') {
    // Skip the one-shot / costly ones unless asked (they consume a match or a live season step).
    const skip = new Set((process.env.ATK_SKIP ?? 'low-gas-play').split(',').filter(Boolean));
    for (const a of ATTACKS) if (!skip.has(a.name)) record(await runOne(a));
    return;
  }
  const a = ATTACKS.find((x) => x.name === name);
  if (!a) {
    console.error(`usage: cli <${ATTACKS.map((x) => x.name).join('|')}|no-season|season|all|render|spend [start|end]>`);
    process.exit(2);
  }
  record(await runOne(a, { noSeason: process.env.ATK_NO_SEASON === '1' }));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
