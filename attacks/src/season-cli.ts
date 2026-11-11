// Attack-season orchestration: `pnpm --filter @osd/attacks run season-ctl <step>`.
//   setup  create the outsider (atk7) and clone-farm owner (clone7), register the clone agents
//   open   open the attack season as the contract owner (parent) and wait for on_pubkey
//   enter  honest commits for the plain entries (claims season-1 winnings first if the budget is short)
//   close  after the commit deadline: close_commits + schedule every round (sent by the outsider)
//   status print the season, matches by status and the leaderboard
// Playing the matches is the ops keeper's job:
//   pnpm --filter @osd/ops keeper --season <id> --runs-dir ../attacks/runs --execute
import { readFileSync } from 'node:fs';
import { actions, PublicKey } from 'near-api-js';
import { sealPrompt } from '@osd/sdk';
import { ATTACKER, CLONE_OWNER, CONTRACT, PARENT, TGAS, balance, head, keyFile, milliNear, send, sleep, view, NEAR } from './lib/near.ts';
import {
  agentId,
  allMatches,
  commitEntry,
  ensureBudget,
  hasKey,
  loadPlan,
  loadState,
  newKeyFile,
  readPrompt,
  saveSalt,
  saveState,
  type LeaderboardRow,
  type Season,
} from './lib/season.ts';

const near = (s: string): bigint => {
  const [i, f = ''] = s.split('.');
  return BigInt(i) * NEAR + BigInt((f + '0'.repeat(24)).slice(0, 24));
};

function must(ok: boolean, msg: string): void {
  if (!ok) {
    console.error(msg);
    process.exit(1);
  }
}

async function ensureAccount(id: string, fund: bigint): Promise<string | null> {
  if ((await balance(id)) !== null) {
    console.log(`${id} exists`);
    return null;
  }
  const pub = newKeyFile(id);
  const o = await send(PARENT, id, [actions.createAccount(), actions.transfer(fund), actions.addFullAccessKey(PublicKey.fromString(pub))]);
  must(o.ok, `create ${id} failed: ${o.error}`);
  console.log(`created ${id} (${Number(fund / 10n ** 21n) / 1000} NEAR) tx ${o.txHash}`);
  return o.txHash;
}

async function setup(): Promise<void> {
  const plan = loadPlan();
  const st = loadState();
  const t1 = await ensureAccount(ATTACKER, milliNear(400));
  if (t1) st.setup_txs[`create ${ATTACKER}`] = t1;
  const clones = plan.agents.filter((a) => a.owner === 'clone7');
  const dep = near(plan.clone_register_deposit_near);
  const t2 = await ensureAccount(CLONE_OWNER, dep * BigInt(clones.length) + milliNear(150));
  if (t2) st.setup_txs[`create ${CLONE_OWNER}`] = t2;
  for (const a of clones) {
    const id = agentId(a.name);
    if (await view('get_agent', { agent_id: id })) {
      console.log(`${id} registered`);
      continue;
    }
    const pub = hasKey(id) ? JSON.parse(readFileSync(keyFile(id), 'utf8')).public_key : newKeyFile(id);
    const o = await send(CLONE_OWNER, CONTRACT, [actions.functionCall('register_agent', { name: a.name, agent_public_key: pub }, 50n * TGAS, dep)]);
    must(o.ok, `register ${id} failed: ${o.error}`);
    st.setup_txs[`register ${id}`] = o.txHash;
    console.log(`registered ${id} tx ${o.txHash}`);
  }
  saveState(st);
}

function resolveRel(x: string, nowNs: bigint): string {
  const m = /^\+(\d+)([smh])$/.exec(x);
  if (!m) return x;
  return String(nowNs + BigInt(m[1]) * { s: 1n, m: 60n, h: 3600n }[m[2] as 's' | 'm' | 'h'] * 1_000_000_000n);
}

async function open(): Promise<void> {
  const st = loadState();
  const cfg = await view<{ owner: string; current_season_id: number | null }>('get_config');
  must(cfg.owner === PARENT, `contract owner is ${cfg.owner}, not ${PARENT}`);
  if (st.season_id !== null) {
    console.log(`attack season already recorded: ${st.season_id}`);
    return;
  }
  const cur = cfg.current_season_id === null ? null : await view<Season>('get_season', { season_id: cfg.current_season_id });
  must(cur === null || ['settled', 'cancelled', 'key_failed'].includes(cur.status), `season ${cur?.season_id} is ${cur?.status}; not opening`);
  const plan = loadPlan();
  const { timestampNs } = await head();
  const params = { ...plan.params, commit_deadline_ns: resolveRel(plan.params.commit_deadline_ns, timestampNs), play_deadline_ns: resolveRel(plan.params.play_deadline_ns, timestampNs) };
  const o = await send(PARENT, CONTRACT, [actions.functionCall('open_season', { params }, 300n * TGAS, milliNear(50))]);
  must(o.ok, `open_season failed: ${o.error}`);
  const sid = Number(o.value); // open_season returns the new id directly (interfaces-v4)
  must(Number.isInteger(sid) && sid > 0, `open_season returned ${JSON.stringify(o.value)}`);
  st.season_id = sid;
  st.open_tx = o.txHash;
  saveState(st);
  console.log(`opened season ${sid} tx ${o.txHash}; waiting for on_pubkey`);
  for (let i = 0; i < 60; i++) {
    const s = await view<Season>('get_season', { season_id: sid });
    if (s.status !== 'pending_key') {
      console.log(`season ${sid}: ${s.status} pubkey ${s.pubkey}`);
      return;
    }
    await sleep(5000);
  }
  console.log('still pending_key; re-run `season status`');
}

async function enter(): Promise<void> {
  const st = loadState();
  must(st.season_id !== null, 'no attack season; run `season open`');
  const sid = st.season_id!;
  const s = await view<Season>('get_season', { season_id: sid });
  must(s.status === 'commit' && s.pubkey !== null, `season ${sid} is ${s.status}`);
  const plan = loadPlan();
  // Plain entries only; duplicate / mismatch / clone commits are the attacks themselves.
  const plain = plan.agents.filter((a) => !a.roles.some((r) => ['duplicate', 'mismatch', 'clone'].includes(r)));
  const entered = new Set((await view<{ agent_id: string }[]>('get_entries', { season_id: sid, limit: 200 })).map((e) => e.agent_id));
  for (const a of plain) {
    const id = agentId(a.name);
    if (entered.has(id)) continue;
    await ensureBudget(id, BigInt(s.entry_deposit_yocto));
    const prompt = readPrompt(a.prompt_file);
    const sealed = sealPrompt(s.pubkey!, prompt, id);
    saveSalt(id, { salt: sealed.salt, commitment: sealed.commitment, prompt_file: a.prompt_file });
    const o = await commitEntry(sid, id, sealed.ciphertext_hex, sealed.commitment, a.family);
    must(o.ok, `commit ${id} failed: ${o.error}`);
    st.commits[id] = { tx: o.txHash, kind: 'honest' };
    saveState(st);
    console.log(`committed ${id} (${a.family}) tx ${o.txHash}`);
  }
}

async function close(): Promise<void> {
  const st = loadState();
  const sid = st.season_id!;
  let s = await view<Season>('get_season', { season_id: sid });
  if (s.status === 'commit') {
    for (;;) {
      const { timestampNs } = await head();
      if (timestampNs > BigInt(s.params.commit_deadline_ns)) break;
      const left = Number((BigInt(s.params.commit_deadline_ns) - timestampNs) / 1_000_000_000n);
      console.log(`commit deadline in ${left}s`);
      await sleep(Math.min(30, left + 2) * 1000);
    }
    const o = await send(ATTACKER, CONTRACT, [actions.functionCall('close_commits', { season_id: sid }, 30n * TGAS, 0n)]);
    must(o.ok, `close_commits failed: ${o.error}`);
    st.setup_txs['close_commits'] = o.txHash;
    console.log(`close_commits (by outsider ${ATTACKER}) → ${JSON.stringify(o.value)} tx ${o.txHash}`);
    s = await view<Season>('get_season', { season_id: sid });
  }
  while (s.rounds_scheduled < s.total_rounds) {
    const o = await send(ATTACKER, CONTRACT, [actions.functionCall('schedule_round', { season_id: sid }, 100n * TGAS, 0n)]);
    must(o.ok, `schedule_round failed: ${o.error}`);
    st.setup_txs[`schedule_round ${s.rounds_scheduled}`] = o.txHash;
    s = await view<Season>('get_season', { season_id: sid });
    console.log(`scheduled round ${s.rounds_scheduled}/${s.total_rounds} tx ${o.txHash}`);
  }
  saveState(st);
}

async function status(): Promise<void> {
  const sid = loadState().season_id;
  if (sid === null) return console.log('no attack season');
  const s = await view<Season>('get_season', { season_id: sid });
  console.log(JSON.stringify({ ...s, pubkey: s.pubkey?.slice(0, 12) }, null, 1));
  const ms = await allMatches(sid);
  const by: Record<string, number> = {};
  for (const m of ms) by[m.status] = (by[m.status] ?? 0) + 1;
  console.log('matches', by);
  for (const r of await view<LeaderboardRow[]>('get_leaderboard', { season_id: sid })) {
    console.log(`${String(r.rank ?? '-').padStart(2)} ${r.agent_id.split('.')[0].padEnd(16)} ${r.owner.split('.')[0].padEnd(7)} counted=${r.matches_counted} avg=${r.avg_payoff_milli}`);
  }
}

const step = process.argv[2];
const steps: Record<string, () => Promise<void>> = { setup, open, enter, close, status };
if (!step || !steps[step]) {
  console.error(`usage: season <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
steps[step]().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
