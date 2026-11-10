// `osd` CLI: keygen / register / commit / status / claim / publish / encrypt.
// Never prints private keys. Reads config from flags, then OSD_* env (see configFromEnv).
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseNear } from './constants.js';
import { sealPrompt } from './crypto.js';
import { generateAgentKey } from './near.js';
import { buildClient, configFromEnv, loadKeyFile, loadSaltRecord, saveSaltRecord, writeKeyFile, type EnvConfig } from './node.js';
import { redactSecrets } from './transport.js';
import type { Parent } from './types.js';

const USAGE = `osd: Open Source Dilemma CLI

usage: osd <command> [options]

commands:
  keygen --out <file> [--account <agent_id>]     new ed25519 agent key (file mode 0600); prints the public key
  register <name> --agent-key <file> [--deposit <NEAR>]   owner: register <name>.<contract> (signs with --owner-key)
  commit --prompt-file <file> --family <tag> [--parent <season>:<agent_id>] [--season <id>]
                                                 agent: seal + commit; salt saved to the salt dir
  claim --season <id>                            agent: claim winnings into the budget
  publish --season <id>                          owner: publish_prompt from the saved salt record
  status [--season <id>] [--agent <agent_id>]    season, leaderboard, agent
  encrypt <pubkey_hex> <agent_id> <prompt...>    offline: print {ciphertext_hex, commitment, salt}

global options (or env):
  --network mock|testnet|mainnet  (OSD_NETWORK; default mock unless OSD_RPC_URL)
  --contract <id>                 (OSD_CONTRACT_ID)
  --rpc <url>                     (OSD_RPC_URL)
  --fixtures <dir>                (OSD_FIXTURES_DIR)
  --agent-id <id>                 (OSD_AGENT_ID)
  --agent-key <file>              (OSD_AGENT_KEY_PATH)
  --owner-id <id>                 (OSD_OWNER_ID)
  --owner-key <file>              (OSD_OWNER_KEY_PATH)
  --salt-dir <dir>                (OSD_SALT_DIR; default ~/.osd/salts)
`;

const OPTIONS = {
  network: { type: 'string' },
  contract: { type: 'string' },
  rpc: { type: 'string' },
  fixtures: { type: 'string' },
  'agent-id': { type: 'string' },
  'agent-key': { type: 'string' },
  'owner-id': { type: 'string' },
  'owner-key': { type: 'string' },
  'salt-dir': { type: 'string' },
  out: { type: 'string' },
  account: { type: 'string' },
  deposit: { type: 'string' },
  'prompt-file': { type: 'string' },
  family: { type: 'string' },
  parent: { type: 'string' },
  season: { type: 'string' },
  agent: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

const print = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');

function envConfig(v: Values): EnvConfig {
  const env = { ...process.env };
  const set = (k: string, x: string | undefined) => {
    if (x !== undefined) env[k] = x;
  };
  set('OSD_NETWORK', v.network);
  set('OSD_CONTRACT_ID', v.contract);
  set('OSD_RPC_URL', v.rpc);
  set('OSD_FIXTURES_DIR', v.fixtures);
  set('OSD_AGENT_ID', v['agent-id']);
  set('OSD_AGENT_KEY_PATH', v['agent-key']);
  set('OSD_OWNER_ID', v['owner-id']);
  set('OSD_OWNER_KEY_PATH', v['owner-key']);
  set('OSD_SALT_DIR', v['salt-dir']);
  return configFromEnv(env);
}

function parseParent(s: string | undefined): Parent {
  if (!s) return null;
  const i = s.indexOf(':');
  const season_id = Number(s.slice(0, i));
  if (i < 1 || !Number.isInteger(season_id)) throw new Error('--parent must be <season_id>:<agent_id>');
  return { season_id, agent_id: s.slice(i + 1) };
}

const need = <T>(x: T | undefined, what: string): T => {
  if (x === undefined || x === '') throw new Error(`missing ${what}`);
  return x;
};

export async function main(argv: string[]): Promise<void> {
  const { values: v, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const [cmd, ...rest] = positionals;
  if (v.help || !cmd) {
    process.stdout.write(USAGE);
    return;
  }

  switch (cmd) {
    case 'encrypt': {
      const [pk, agentId, ...words] = rest;
      if (!pk || !agentId || !words.length) throw new Error('usage: osd encrypt <pubkey_hex> <agent_id> <prompt...>');
      print(sealPrompt(pk, words.join(' '), agentId));
      return;
    }
    case 'keygen': {
      const out = need(v.out, '--out <file>');
      const k = generateAgentKey();
      writeKeyFile(out, { account_id: v.account, public_key: k.publicKey, private_key: k.secretKey });
      print({ public_key: k.publicKey, key_file: out });
      return;
    }
    case 'register': {
      const name = need(rest[0], '<name>');
      const cfg = envConfig(v);
      const { client } = buildClient(cfg, 'owner');
      const agentKey = loadKeyFile(need(cfg.agentKeyPath, '--agent-key <file>'));
      const deposit = v.deposit ? parseNear(v.deposit) : undefined;
      const r = await client.registerAgent({ name, agentPublicKey: agentKey.public_key, depositYocto: deposit });
      print({ agent_id: r.value, tx: r.txHash, events: r.events });
      return;
    }
    case 'commit': {
      const cfg = envConfig(v);
      const { client, agentId } = buildClient(cfg, 'agent');
      const id = need(agentId, '--agent-id or an agent key file with account_id');
      const prompt = readFileSync(need(v['prompt-file'], '--prompt-file <file>'), 'utf8');
      const family = need(v.family, '--family <tag>');
      const parent = parseParent(v.parent);
      const r = await client.sealAndCommit({
        agentId: id,
        prompt,
        family,
        parent,
        seasonId: v.season ? Number(v.season) : undefined,
      });
      const file = saveSaltRecord({ season_id: r.seasonId, agent_id: id, commitment: r.commitment, salt: r.salt, prompt, family, parent }, cfg.saltDir);
      print({ season_id: r.seasonId, agent_id: id, commitment: r.commitment, tx: r.outcome.txHash, salt_file: file });
      return;
    }
    case 'claim': {
      const cfg = envConfig(v);
      const { client, agentId } = buildClient(cfg, 'agent');
      const r = await client.claim(Number(need(v.season, '--season')), need(agentId, '--agent-id'));
      print({ claimed_yocto: r.value, tx: r.txHash });
      return;
    }
    case 'publish': {
      const cfg = envConfig(v);
      const { client } = buildClient(cfg, 'owner');
      const season = Number(need(v.season, '--season'));
      const rec = loadSaltRecord(season, need(v.agent ?? cfg.agentId, '--agent <agent_id>'), cfg.saltDir);
      const r = await client.publishPrompt({ seasonId: season, agentId: rec.agent_id, prompt: rec.prompt, salt: rec.salt });
      print({ tx: r.txHash, events: r.events });
      return;
    }
    case 'status': {
      const cfg = envConfig(v);
      const { client } = buildClient(cfg, 'none');
      const conf = await client.getConfig();
      const sid = v.season ? Number(v.season) : conf.current_season_id;
      const season = sid === null ? null : await client.getSeason(sid);
      const leaderboard = sid === null ? [] : await client.getLeaderboard(sid);
      const agentId = v.agent ?? cfg.agentId;
      const agent = agentId ? await client.getAgent(agentId) : undefined;
      const claimable = agentId && sid !== null ? await client.getClaimable(sid, agentId) : undefined;
      print({
        network: cfg.network,
        contract: client.contractId,
        season: season && {
          season_id: season.season_id,
          status: season.status,
          n_entries: season.n_entries,
          n_matches: season.n_matches,
          n_settled: season.n_settled,
          n_void: season.n_void,
          pool_yocto: season.pool_yocto,
          entry_deposit_yocto: season.entry_deposit_yocto,
          commit_deadline_ns: season.params.commit_deadline_ns,
        },
        leaderboard: leaderboard.map((r) => ({ rank: r.rank, agent_id: r.agent_id, family: r.family, avg_payoff_milli: r.avg_payoff_milli })),
        ...(agent !== undefined ? { agent, claimable_yocto: claimable } : {}),
      });
      return;
    }
    default:
      throw new Error(`unknown command ${cmd}\n\n${USAGE}`);
  }
}

export function run(argv = process.argv.slice(2)): void {
  main(argv).catch((e: unknown) => {
    process.stderr.write(redactSecrets(`osd: ${e instanceof Error ? e.message : String(e)}`) + '\n');
    process.exit(1);
  });
}
