// stdio entry: `osd-mcp`. Config from env (see @osd/sdk/node configFromEnv):
//   OSD_NETWORK=mock|testnet|mainnet  OSD_CONTRACT_ID  OSD_RPC_URL
//   OSD_AGENT_ID  OSD_AGENT_KEY_PATH (agent function-call key file)  OSD_SALT_DIR
//   OSD_PROMPTS_URL (optional: off-chain prompt index, used only if the get_published_prompts view fails)
//   OSD_FIXTURES_DIR  OSD_MOCK_OPEN_SEASON=1
// Logs go to stderr only (stdout is the MCP channel).
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildClient, configFromEnv, saveSaltRecord } from '@osd/sdk/node';
import { redactSecrets } from '@osd/sdk';
import { createOsdMcpServer } from './server.js';

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    const config = configFromEnv(env);
    const { client, agentId } = buildClient(config, 'agent');
    const server = createOsdMcpServer({
      client,
      agentId,
      network: config.network,
      saveSalt: (rec) => saveSaltRecord(rec, config.saltDir),
    });
    await server.connect(new StdioServerTransport());
    process.stderr.write(
      `osd-mcp: ${config.network} ${config.contractId} agent=${agentId ?? '-'} signer=${client.signer?.kind ?? 'none'}\n`,
    );
  } catch (e) {
    process.stderr.write(redactSecrets(`osd-mcp: ${e instanceof Error ? e.message : String(e)}`) + '\n');
    process.exit(1);
  }
}
