#!/usr/bin/env node
// WS-8: mint a settled season's strategy cards + badges on the cards contract (contracts/cards).
// Reads core views (get_season, get_leaderboard, get_entries), skips cards already minted, then calls
// `mint_season_cards` in batches. DRY RUN by default; --execute signs as the cards contract owner.
//
//   pnpm --filter @osd/ops mint-cards --season N [--execute]
//
// Journal: ops/runs/cards-season-<n>.jsonl (tx hashes; never secrets).

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { badgeTokenId, buildCardRows, cardTokenId, chunk, MINT_BATCH, settleTxFrom, type EntryView, type LeaderboardRowView } from '../cards.ts';
import { loadSignerKey, NearChain } from '../near-chain.ts';
import { DEFAULT_RPC } from '../rpc.ts';
import { readJsonl } from '../txlog.ts';
import { banner, DEFAULTS, die, REPO_DIR, RUNS_DIR } from './common.ts';

export const CARDS_DEFAULT = 'cards.osd.baldingsucks7993.testnet';

const USAGE = `usage: pnpm --filter @osd/ops mint-cards --season N [options]

  --season <n>          settled season to card (required)
  --network <testnet>   (default testnet)
  --rpc <url>           RPC url (default fastnear)
  --contract <id>       core contract (default ${DEFAULTS.contract})
  --cards <id>          cards contract (default ${CARDS_DEFAULT})
  --signer <id>         cards contract owner (default ${DEFAULTS.signer})
  --settle-tx <hash>    settle_season tx (default: from ops/runs/<n>.jsonl)
  --plan <file>         house plan for families (default agents/plans/season-<n>[.seed].json if present)
  --batch <k>           rows per mint call (default ${MINT_BATCH})
  --execute             sign and send (default: dry run)`;

function planFamilies(file: string | undefined, seasonId: number): Map<string, string> {
  const candidates = file ? [file] : [`season-${seasonId}.json`, `season-${seasonId}.seed.json`].map((f) => join(REPO_DIR, 'agents', 'plans', f));
  const path = candidates.find((p) => existsSync(p));
  if (!path) return new Map();
  const plan = JSON.parse(readFileSync(path, 'utf8')) as { season_id?: number; entries?: { agent_id: string; family: string }[] };
  if (plan.season_id !== undefined && plan.season_id !== seasonId) return new Map();
  console.error(`families from ${path}`);
  return new Map((plan.entries ?? []).map((e) => [e.agent_id, e.family]));
}

async function main(): Promise<void> {
  const { values: v } = parseArgs({
    options: {
      season: { type: 'string' },
      network: { type: 'string', default: DEFAULTS.network },
      rpc: { type: 'string' },
      contract: { type: 'string', default: DEFAULTS.contract },
      cards: { type: 'string', default: CARDS_DEFAULT },
      signer: { type: 'string', default: DEFAULTS.signer },
      'settle-tx': { type: 'string' },
      plan: { type: 'string' },
      batch: { type: 'string' },
      execute: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (v.help) {
    console.log(USAGE);
    return;
  }
  const seasonId = Number(v.season);
  if (!Number.isInteger(seasonId) || seasonId < 1) die(`--season N required\n${USAGE}`);
  if (v.network !== 'testnet') die('testnet only in this phase');
  const batch = v.batch ? Number(v.batch) : MINT_BATCH;
  if (!Number.isInteger(batch) || batch < 1 || batch > 50) die('--batch must be 1..50');
  const rpcUrl = v.rpc ?? DEFAULT_RPC[v.network!]!;
  const execute = v.execute!;
  banner(execute);

  const core = new NearChain({ network: v.network!, rpcUrl, contractId: v.contract!, signerId: v.signer! });
  const season = await core.view<{ status: string; n_entries: number } | null>('get_season', { season_id: seasonId });
  if (!season) die(`season ${seasonId} not found on ${v.contract}`);
  if (season.status !== 'settled') die(`season ${seasonId} is ${season.status}, not settled`);
  const leaderboard = await core.view<LeaderboardRowView[]>('get_leaderboard', { season_id: seasonId });
  const entries: EntryView[] = [];
  while (entries.length < season.n_entries) {
    const page = await core.view<EntryView[]>('get_entries', { season_id: seasonId, from_index: entries.length, limit: 50 });
    if (page.length === 0) break;
    entries.push(...page);
  }
  const rows = buildCardRows(leaderboard, entries, planFamilies(v.plan, seasonId));
  const settleTx = v['settle-tx'] ?? settleTxFrom(readJsonl(join(RUNS_DIR, `${seasonId}.jsonl`)), seasonId);
  console.error(`season ${seasonId}: ${rows.length} entries, settle_tx ${settleTx ?? '(unknown)'}`);

  const cards = new NearChain({
    network: v.network!,
    rpcUrl,
    contractId: v.cards!,
    signerId: v.signer!,
    key: execute ? loadSignerKey(v.network!, v.signer!) : undefined,
  });
  const cfg = await cards.view<{ owner: string; core_contract: string }>('get_config', {}).catch(() => null);
  if (cfg) {
    if (cfg.core_contract !== v.contract) die(`${v.cards} is bound to ${cfg.core_contract}, not ${v.contract}`);
    if (cfg.owner !== v.signer) die(`${v.cards} owner is ${cfg.owner}; --signer ${v.signer} cannot mint`);
  } else if (execute) die(`${v.cards} has no cards contract (run ops/scripts/deploy-cards.sh --execute first)`);
  else console.error(`${v.cards}: not deployed yet (dry run shows every row as new)`);

  const ids = rows.map((r) => cardTokenId(seasonId, r.agent_id));
  const existing = cfg ? await cards.view<(object | null)[]>('mt_token', { token_ids: ids }) : ids.map(() => null);
  const todo = rows.filter((_, i) => existing[i] === null);
  console.error(`${rows.length - todo.length} already minted, ${todo.length} to mint`);
  for (const r of rows) console.error(`  ${cardTokenId(seasonId, r.agent_id)} -> ${r.owner} rank=${r.rank} family=${r.family}${r.parent ? ` parent=${cardTokenId(r.parent.season_id, r.parent.agent_id)}` : ''}`);

  const journal = join(RUNS_DIR, `cards-season-${seasonId}.jsonl`);
  const log = (rec: Record<string, unknown>): void => {
    const line = JSON.stringify({ ts: new Date().toISOString(), season_id: seasonId, ...rec });
    console.log(line);
    if (execute) appendFileSync(journal, line + '\n');
  };
  for (const part of chunk(todo, batch)) {
    const args = { season_id: seasonId, cards: part, settle_tx: settleTx };
    if (!execute) {
      log({ kind: 'tx', method: 'mint_season_cards', contract: v.cards, outcome: 'dry_run', token_ids: part.map((r) => cardTokenId(seasonId, r.agent_id)) });
      continue;
    }
    const res = await cards.call('mint_season_cards', args, { gas: 300_000_000_000_000n });
    log({ kind: 'tx', method: 'mint_season_cards', contract: v.cards, signer: v.signer, tx_hash: res.txHash, outcome: 'ok', block: res.block, token_ids: res.value });
  }
  if (execute && cfg) {
    const badge = badgeTokenId(seasonId);
    // views run at final finality, a block or two behind the INCLUDED_FINAL send
    let supply: string | null = null;
    for (let i = 0; i < 10 && supply === null; i++) {
      supply = await cards.view<string | null>('mt_supply', { token_id: badge });
      if (supply === null) await cards.sleep(1500);
    }
    log({ kind: 'info', msg: 'minted', badge, badge_supply: supply, cards: ids.length });
  }
}

main().catch((e: unknown) => die(e instanceof Error ? e.message : String(e), 1));
