// House agents: one owner account per agent (h01..hNN under the ops account),
// because the contract caps entries per owner and ranks only against distinct
// owners. Reads a WS-4 commit plan (agents/plans/season-<n>.json): entries
// map agent id → prompt file; the prompt is the file body with frontmatter
// stripped and whitespace trimmed (same as agents/src/strategy.ts readStrategy).
//
// planSteps() is pure: given what already exists on chain it returns only the
// missing steps, so re-running never re-creates, re-registers or re-commits.

import type { Parent } from './types.ts';

export interface PlanEntry {
  agent_id: string;
  name: string;
  family: string;
  parent: Parent | null;
  prompt_file: string;
  prompt_bytes?: number;
  role?: string;
}

export interface CommitPlan {
  plan_version: number;
  season_id: number;
  contract: string;
  entries: PlanEntry[];
}

export interface AgentView {
  agent_id: string;
  owner: string;
  budget_yocto: string;
}

export const NAME_RE = /^[a-z0-9_-]{2,16}$/;
export const FAMILY_RE = /^[a-z0-9_]{1,32}$/;
export const PROMPT_MAX_BYTES = 4000;
export const AGENT_ACCOUNT_FUNDING = 200_000_000_000_000_000_000_000n; // 0.2 NEAR
export const MIN_REGISTER_DEPOSIT = 250_000_000_000_000_000_000_000n; // 0.25 NEAR

/** Body of a strategy file: frontmatter (--- … ---) removed, trimmed. Mirrors agents/src/frontmatter.ts. */
export function promptFromStrategyFile(text: string): string {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) throw new Error('missing opening --- frontmatter fence');
  const end = src.indexOf('\n---\n', 3);
  if (end < 0) throw new Error('missing closing --- frontmatter fence');
  return src.slice(end + 5).trim();
}

export function ownerIdFor(index: number, opsAccount: string, prefix = 'h'): string {
  return `${prefix}${String(index + 1).padStart(2, '0')}.${opsAccount}`;
}

export function validatePlan(plan: CommitPlan, contract: string, maxOwners: number): string[] {
  const errs: string[] = [];
  if (plan.contract !== contract) errs.push(`plan.contract ${plan.contract} != ${contract}`);
  if (plan.entries.length > maxOwners) errs.push(`${plan.entries.length} entries but only ${maxOwners} owner accounts`);
  const seen = new Set<string>();
  for (const e of plan.entries) {
    if (!NAME_RE.test(e.name)) errs.push(`${e.name}: name must match ${NAME_RE}`);
    if (e.agent_id !== `${e.name}.${contract}`) errs.push(`${e.name}: agent_id ${e.agent_id} != ${e.name}.${contract}`);
    if (!FAMILY_RE.test(e.family)) errs.push(`${e.name}: family ${e.family} must match ${FAMILY_RE}`);
    if (seen.has(e.agent_id)) errs.push(`${e.agent_id}: duplicate`);
    seen.add(e.agent_id);
  }
  return errs;
}

export type Step =
  | { kind: 'create_owner'; owner: string; agent_id: string; fund_yocto: string }
  | { kind: 'register_agent'; owner: string; name: string; agent_id: string; deposit_yocto: string }
  | { kind: 'fund_agent'; owner: string; agent_id: string; deposit_yocto: string }
  | { kind: 'commit'; owner: string; agent_id: string; family: string; parent: Parent | null; prompt_file: string }
  | { kind: 'skip'; owner: string; agent_id: string; reason: string };

export interface ChainFacts {
  accountExists: (id: string) => boolean;
  agent: (agentId: string) => AgentView | null;
  entered: (agentId: string) => boolean;
}

export interface PlanOptions {
  opsAccount: string;
  ownerPrefix?: string;
  /** Season entry_deposit_yocto (bond + 3·unit·(max_agents−1)); the agent's budget must cover it. */
  entryDepositYocto: bigint;
  /** Extra NEAR left on each owner for gas + its own storage. */
  gasMarginYocto: bigint;
  /** Restrict to these agent names (owner numbering still follows plan order). */
  only?: Set<string>;
}

export function registerDeposit(entryDeposit: bigint): bigint {
  const d = AGENT_ACCOUNT_FUNDING + entryDeposit;
  return d < MIN_REGISTER_DEPOSIT ? MIN_REGISTER_DEPOSIT : d;
}

export function planSteps(plan: CommitPlan, facts: ChainFacts, o: PlanOptions): Step[] {
  const steps: Step[] = [];
  const reg = registerDeposit(o.entryDepositYocto);
  plan.entries.forEach((e, i) => {
    if (o.only && !o.only.has(e.name)) return;
    const owner = ownerIdFor(i, o.opsAccount, o.ownerPrefix);
    if (facts.entered(e.agent_id)) {
      steps.push({ kind: 'skip', owner, agent_id: e.agent_id, reason: 'already committed this season' });
      return;
    }
    const agent = facts.agent(e.agent_id);
    if (agent && agent.owner !== owner) {
      steps.push({ kind: 'skip', owner, agent_id: e.agent_id, reason: `agent registered by ${agent.owner}, not ${owner}` });
      return;
    }
    if (!agent) {
      if (!facts.accountExists(owner)) steps.push({ kind: 'create_owner', owner, agent_id: e.agent_id, fund_yocto: String(reg + o.gasMarginYocto) });
      steps.push({ kind: 'register_agent', owner, name: e.name, agent_id: e.agent_id, deposit_yocto: String(reg) });
    } else if (BigInt(agent.budget_yocto) < o.entryDepositYocto) {
      steps.push({ kind: 'fund_agent', owner, agent_id: e.agent_id, deposit_yocto: String(o.entryDepositYocto - BigInt(agent.budget_yocto)) });
    }
    steps.push({ kind: 'commit', owner, agent_id: e.agent_id, family: e.family, parent: e.parent, prompt_file: e.prompt_file });
  });
  return steps;
}
