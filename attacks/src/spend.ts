// Balance snapshots of every account the attack suite signs with: `run spend start` / `run spend end`.
// Net spend = Σ(start − end) over all of them (contract storage for the attack season included);
// agent budgets and claimables held inside the contract are listed separately.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ATTACKER, CLONE_OWNER, CONTRACT, PARENT, balance } from './lib/near.ts';
import { ATTACKS_DIR } from './lib/results.ts';
import { agentId, loadPlan, ownerId } from './lib/season.ts';

const FILE = join(ATTACKS_DIR, 'state', 'balances.json');

function accounts(): string[] {
  const plan = loadPlan();
  const owners = [...new Set(plan.agents.map((a) => ownerId(a.owner)))];
  return [PARENT, CONTRACT, ATTACKER, CLONE_OWNER, ...owners.filter((o) => o !== CLONE_OWNER), ...plan.agents.map((a) => agentId(a.name))];
}

const fmt = (y: bigint): string => (Number(y / 10n ** 18n) / 1e6).toFixed(6);

/** `which` = snapshot name to save; `base` = snapshot to diff against (e.g. `spend ns-end ns-start`). */
export async function spend(which = 'end', base = 'start'): Promise<void> {
  const snap: Record<string, string | null> = {};
  for (const a of accounts()) snap[a] = (await balance(a))?.toString() ?? null;
  const cur = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, unknown>) : {};
  cur[which] = { at: new Date().toISOString(), balances: snap };
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(cur, null, 2) + '\n');
  const start = (cur[base] as { balances: Record<string, string | null> } | undefined)?.balances;
  if (!start || which === base) return console.log(`snapshot "${which}" saved (${Object.keys(snap).length} accounts)`);
  let total = 0n;
  for (const [a, s] of Object.entries(start)) {
    const e = snap[a];
    const d = BigInt(s ?? '0') - BigInt(e ?? '0');
    total += d;
    if (d !== 0n) console.log(`${a.padEnd(48)} ${fmt(d).padStart(12)} NEAR`);
  }
  console.log(`net testnet NEAR spent (all signer accounts + contract): ${fmt(total)}`);
}
