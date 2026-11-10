// MCP server exposing the OSD SDK as tools for agent players.
// Security: tool output never includes private keys (signers hold them; errors are redacted) and
// never includes the commit salt (written to a 0600 file instead) so transcripts can't be used to
// test prompt guesses against a commitment during the commit window.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { FAMILY_RE, MAX_PROMPT_BYTES, redactSecrets, type Match, type OsdClient, type Parent } from '@osd/sdk';

export const SERVER_NAME = 'osd';
export const SERVER_VERSION = '0.1.0';

export interface OsdMcpOptions {
  client: OsdClient;
  /** Agent account the signer acts as (`<name>.<contract>`). Default for agent_id args. */
  agentId?: string;
  network?: string;
  /** Persist the salt of each commit (publish_prompt needs it). Returns the file path. */
  saveSalt?: (rec: {
    season_id: number;
    agent_id: string;
    commitment: string;
    salt: string;
    prompt: string;
    family: string;
    parent: Parent;
  }) => string;
}

const ok = (v: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });
const err = (e: unknown): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: redactSecrets(e instanceof Error ? e.message : String(e)) }],
});
const guard =
  <A>(fn: (a: A) => Promise<unknown>) =>
  async (a: A): Promise<CallToolResult> => {
    try {
      return ok(await fn(a));
    } catch (e) {
      return err(e);
    }
  };

/** Compact match view for LLM context (drops signature blobs). */
const compactMatch = (m: Match) => ({
  match_key: m.match_key,
  round: m.round,
  status: m.status,
  a: m.a,
  b: m.b,
  a_move: m.a_move,
  b_move: m.b_move,
  a_payoff: m.a_payoff,
  b_payoff: m.b_payoff,
  pool_delta: m.pool_delta,
  sig_a_ok: m.sig_a_ok,
  sig_b_ok: m.sig_b_ok,
  void_reason: m.void_reason,
});

const seasonId = z.number().int().min(0).optional().describe('Season id; defaults to the current season');
const agentIdArg = z.string().min(2).max(64).optional().describe('Agent account id (<name>.<contract>); defaults to the configured agent');

export function createOsdMcpServer(o: OsdMcpOptions): McpServer {
  const { client } = o;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const sid = async (s?: number): Promise<number> => {
    if (s !== undefined) return s;
    const cur = (await client.getConfig()).current_season_id;
    if (cur === null) throw new Error('no season has been opened yet');
    return cur;
  };
  const aid = (a?: string): string => {
    const id = a ?? o.agentId;
    if (!id) throw new Error('agent_id is required (no OSD_AGENT_ID configured)');
    return id;
  };

  server.registerTool(
    'whoami',
    {
      description: 'Network, contract and the agent identity this server plays as. Never returns keys.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(async () => ({
      network: o.network ?? null,
      contract_id: client.contractId,
      agent_id: o.agentId ?? null,
      signer: client.signer ? { account_id: client.signer.accountId, key_kind: client.signer.kind } : null,
      can_commit: client.canCall('commit'),
    })),
  );

  server.registerTool(
    'get_season',
    {
      description:
        'Season state: status (pending_key|key_failed|commit|play|settled|cancelled), params (deadlines in ns, unit/bond yocto, model, prize split), entry deposit, counts, pool.',
      inputSchema: { season_id: seasonId },
      annotations: { readOnlyHint: true },
    },
    guard(async (a: { season_id?: number }) => {
      const s = await client.getSeason(await sid(a.season_id));
      if (!s) throw new Error('season not found');
      return s;
    }),
  );

  server.registerTool(
    'get_leaderboard',
    {
      description: 'Ranking of a season: avg payoff (milli-units) vs distinct owners, rank (null = no counted matches), prize.',
      inputSchema: { season_id: seasonId },
      annotations: { readOnlyHint: true },
    },
    guard(async (a: { season_id?: number }) => client.getLeaderboard(await sid(a.season_id))),
  );

  server.registerTool(
    'get_matches',
    {
      description: 'Match results of a season (moves C/D/F, payoffs in units, status, void reason). Filter by agent and/or status.',
      inputSchema: {
        season_id: seasonId,
        agent_id: z.string().optional().describe('Only matches involving this agent'),
        status: z.enum(['scheduled', 'pending', 'settled', 'void', 'refunded']).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (a: { season_id?: number; agent_id?: string; status?: Match['status'] }) => {
      const s = await sid(a.season_id);
      const ms = a.status ? await client.getAllMatches(s, a.status) : await client.getAllMatches(s);
      return ms.filter((m) => !a.agent_id || m.a === a.agent_id || m.b === a.agent_id).map(compactMatch);
    }),
  );

  server.registerTool(
    'get_agent',
    {
      description: 'Agent record: owner, budget (yocto) held in the contract, seasons entered.',
      inputSchema: { agent_id: agentIdArg },
      annotations: { readOnlyHint: true },
    },
    guard(async (a: { agent_id?: string }) => {
      const ag = await client.getAgent(aid(a.agent_id));
      if (!ag) throw new Error('agent not found');
      return ag;
    }),
  );

  server.registerTool(
    'get_lineage',
    {
      description:
        "An agent's entries across seasons (commitment, family, parent, rank). With season_id, walks parent links from that entry back to the root.",
      inputSchema: { agent_id: agentIdArg, season_id: z.number().int().min(0).optional().describe('Walk ancestry from this season') },
      annotations: { readOnlyHint: true },
    },
    guard(async (a: { agent_id?: string; season_id?: number }) => {
      const id = aid(a.agent_id);
      return a.season_id === undefined ? client.getLineage(id) : client.getAncestry(a.season_id, id);
    }),
  );

  server.registerTool(
    'get_claimable',
    {
      description: 'Yocto the agent can claim from a season (payoffs, refunds, excess stake, prize, bond).',
      inputSchema: { season_id: seasonId, agent_id: agentIdArg },
      annotations: { readOnlyHint: true },
    },
    guard(async (a: { season_id?: number; agent_id?: string }) => {
      const s = await sid(a.season_id);
      const id = aid(a.agent_id);
      return { season_id: s, agent_id: id, claimable_yocto: await client.getClaimable(s, id) };
    }),
  );

  server.registerTool(
    'list_past_prompts',
    {
      description:
        'Prompts voluntarily published after settlement (on-chain get_published_prompts), each verified against its on-chain commitment and joined with its final rank. Use these to learn which strategies did well.',
      inputSchema: {
        season_id: z.number().int().min(0).optional().describe('Only this season (default: all)'),
        agent_id: z.string().optional(),
        family: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Max prompts (default 50)'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (a: { season_id?: number; agent_id?: string; family?: string; limit?: number }) => {
      const ps = (await client.getPublishedPrompts({ seasonId: a.season_id, agentId: a.agent_id })).filter(
        (p) => !a.family || p.family === a.family,
      );
      const boards = new Map<number, Awaited<ReturnType<OsdClient['getLeaderboard']>>>();
      const out = [];
      for (const p of ps.slice(0, a.limit ?? 50)) {
        if (!boards.has(p.season_id)) boards.set(p.season_id, await client.getLeaderboard(p.season_id));
        const row = boards.get(p.season_id)!.find((r) => r.agent_id === p.agent_id);
        out.push({
          season_id: p.season_id,
          agent_id: p.agent_id,
          family: p.family,
          verified: p.verified,
          rank: row?.rank ?? null,
          avg_payoff_milli: row?.avg_payoff_milli ?? null,
          prompt: p.prompt,
        });
      }
      return out;
    }),
  );

  server.registerTool(
    'seal_and_commit',
    {
      description: `Encrypt your strategy prompt to the season key with a fresh random salt and commit it (one entry per agent per season; stake + bond are debited from the agent budget). Prompt ≤ ${MAX_PROMPT_BYTES} bytes. The salt is saved to a private local file (needed for publish_prompt after settlement) and is NOT returned.`,
      inputSchema: {
        prompt: z.string().min(1).describe('Strategy prompt text (the referee LLM reads it next to the opponent prompt)'),
        family: z.string().regex(FAMILY_RE).describe('Strategy family tag, ^[a-z0-9_]{1,32}$'),
        season_id: seasonId,
        parent_season_id: z.number().int().min(0).optional().describe('Lineage: season of the parent entry'),
        parent_agent_id: z.string().optional().describe('Lineage: agent of the parent entry'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async (a: { prompt: string; family: string; season_id?: number; parent_season_id?: number; parent_agent_id?: string }) => {
      const agentId = aid();
      if (!client.canCall('commit')) throw new Error('no signer configured (set OSD_AGENT_KEY_PATH)');
      if ((a.parent_season_id === undefined) !== (a.parent_agent_id === undefined)) {
        throw new Error('give both parent_season_id and parent_agent_id, or neither');
      }
      const parent: Parent = a.parent_agent_id ? { season_id: a.parent_season_id!, agent_id: a.parent_agent_id } : null;
      const r = await client.sealAndCommit({ agentId, prompt: a.prompt, family: a.family, parent, seasonId: a.season_id });
      const salt_file = o.saveSalt?.({
        season_id: r.seasonId,
        agent_id: agentId,
        commitment: r.commitment,
        salt: r.salt,
        prompt: a.prompt,
        family: a.family,
        parent,
      });
      return {
        season_id: r.seasonId,
        agent_id: agentId,
        commitment: r.commitment,
        tx_hash: r.outcome.txHash,
        salt_saved_to: salt_file ?? null,
        events: r.outcome.events.map((e) => e.event),
      };
    }),
  );

  server.registerTool(
    'claim',
    {
      description: "Move the agent's claimable winnings for a season into its budget (usable for the next commit).",
      inputSchema: { season_id: z.number().int().min(0).describe('Settled season to claim from') },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async (a: { season_id: number }) => {
      const agentId = aid();
      if (!client.canCall('claim')) throw new Error('no signer configured (set OSD_AGENT_KEY_PATH)');
      const r = await client.claim(a.season_id, agentId);
      return { season_id: a.season_id, agent_id: agentId, claimed_yocto: r.value, tx_hash: r.txHash };
    }),
  );

  return server;
}
