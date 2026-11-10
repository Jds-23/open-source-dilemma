// Node-only helpers (`@osd/sdk/node`): fixture loading, key files, salt records, env config.
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OsdClient, httpPromptSource, staticPromptSource, type PromptSource } from './client.js';
import { NETWORKS, type NetworkId } from './constants.js';
import { MockChain, type Fixtures } from './mock.js';
import { RpcViewProvider, agentKeySigner, fullAccessSigner, publicKeyOf } from './near.js';
import type { TxSigner } from './transport.js';
import type { Parent } from './types.js';

/** `interfaces/fixtures/` of this repo. */
export const DEFAULT_FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../interfaces/fixtures');

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));

/** Load `interfaces/fixtures/*.json` (+ `events.jsonl`). */
export function loadFixtures(dir: string = DEFAULT_FIXTURES_DIR): Fixtures {
  const f = (n: string) => join(dir, n);
  return {
    season: readJson(f('season.json')) as Fixtures['season'],
    agents: readJson(f('agents.json')) as Fixtures['agents'],
    entries: readJson(f('entries.json')) as Fixtures['entries'],
    matches: readJson(f('matches.json')) as Fixtures['matches'],
    leaderboard: readJson(f('leaderboard.json')) as Fixtures['leaderboard'],
    lineage: readJson(f('lineage.json')) as Fixtures['lineage'],
    prompts: existsSync(f('prompts.json')) ? (readJson(f('prompts.json')) as Fixtures['prompts']) : [],
    events: existsSync(f('events.jsonl'))
      ? readFileSync(f('events.jsonl'), 'utf8').split('\n').filter((l) => l.trim())
      : [],
  };
}

/** Offline client: MockChain over the repo fixtures, with a static prompt source. */
export function mockClient(o: { fixturesDir?: string; contractId?: string; signerAccountId?: string; signerKind?: 'full_access' | 'function_call' } = {}): {
  client: OsdClient;
  chain: MockChain;
} {
  const fx = loadFixtures(o.fixturesDir);
  const chain = new MockChain(fx, { contractId: o.contractId });
  const client = new OsdClient({
    contractId: chain.contractId,
    provider: chain,
    signer: o.signerAccountId ? chain.signer(o.signerAccountId, o.signerKind) : undefined,
    prompts: { list: (f) => staticPromptSource(chain.prompts).list(f) },
  });
  return { client, chain };
}

export interface KeyFile {
  account_id?: string;
  public_key: string;
  /** `ed25519:<base58>` */
  private_key: string;
}

/**
 * Read a NEAR key file: near-cli credentials JSON (`{account_id, public_key, private_key}`; `secret_key` also accepted)
 * or a plain text file containing `ed25519:<base58>`.
 */
export function loadKeyFile(path: string): KeyFile {
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.startsWith('{')) {
    const j = JSON.parse(raw) as { account_id?: string; public_key?: string; private_key?: string; secret_key?: string };
    const sk = j.private_key ?? j.secret_key;
    if (!sk) throw new Error(`${path}: no private_key`);
    return { account_id: j.account_id, public_key: j.public_key ?? publicKeyOf(sk), private_key: sk };
  }
  return { public_key: publicKeyOf(raw), private_key: raw };
}

/** Write a key file (mode 0600, near-cli format). Refuses to overwrite. */
export function writeKeyFile(path: string, k: KeyFile): void {
  if (existsSync(path)) throw new Error(`${path} exists; refusing to overwrite a key file`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(k, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

export const DEFAULT_SALT_DIR = join(homedir(), '.osd', 'salts');

export interface SaltRecord {
  season_id: number;
  agent_id: string;
  commitment: string;
  salt: string;
  prompt: string;
  family: string;
  parent: Parent;
  created_at: string;
}

/** Persist what `publish_prompt` needs later (mode 0600). Returns the file path. */
export function saveSaltRecord(rec: Omit<SaltRecord, 'created_at'>, dir: string = DEFAULT_SALT_DIR): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, `${rec.season_id}-${rec.agent_id}.json`);
  writeFileSync(p, JSON.stringify({ ...rec, created_at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}

export function loadSaltRecord(seasonId: number, agentId: string, dir: string = DEFAULT_SALT_DIR): SaltRecord {
  return readJson(join(dir, `${seasonId}-${agentId}.json`)) as SaltRecord;
}

export type EnvNetwork = NetworkId | 'mock';

export interface EnvConfig {
  network: EnvNetwork;
  contractId: string;
  rpcUrl?: string;
  fixturesDir: string;
  agentId?: string;
  agentKeyPath?: string;
  ownerId?: string;
  ownerKeyPath?: string;
  saltDir: string;
  promptsUrl?: string;
  mockOpenSeason: boolean;
}

/**
 * Config from env:
 * `OSD_NETWORK` (mock|testnet|mainnet; default mock unless `OSD_RPC_URL` is set, then testnet),
 * `OSD_CONTRACT_ID`, `OSD_RPC_URL`, `OSD_FIXTURES_DIR`, `OSD_AGENT_ID`, `OSD_AGENT_KEY_PATH`,
 * `OSD_OWNER_ID`, `OSD_OWNER_KEY_PATH`, `OSD_SALT_DIR`, `OSD_PROMPTS_URL`, `OSD_MOCK_OPEN_SEASON` (1 = open a commit-phase season in the mock).
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const network = (env.OSD_NETWORK || (env.OSD_RPC_URL ? 'testnet' : 'mock')) as EnvNetwork;
  if (!['mock', 'testnet', 'mainnet'].includes(network)) throw new Error(`OSD_NETWORK must be mock|testnet|mainnet, got ${network}`);
  const net = network === 'mock' ? NETWORKS.testnet : NETWORKS[network];
  const contractId = env.OSD_CONTRACT_ID || net.contractId;
  if (!contractId) throw new Error(`OSD_CONTRACT_ID is required for ${network}`);
  return {
    network,
    contractId,
    rpcUrl: network === 'mock' ? undefined : env.OSD_RPC_URL || net.rpcUrl,
    fixturesDir: env.OSD_FIXTURES_DIR || DEFAULT_FIXTURES_DIR,
    agentId: env.OSD_AGENT_ID || undefined,
    agentKeyPath: env.OSD_AGENT_KEY_PATH || undefined,
    ownerId: env.OSD_OWNER_ID || undefined,
    ownerKeyPath: env.OSD_OWNER_KEY_PATH || undefined,
    saltDir: env.OSD_SALT_DIR || DEFAULT_SALT_DIR,
    promptsUrl: env.OSD_PROMPTS_URL || undefined,
    mockOpenSeason: env.OSD_MOCK_OPEN_SEASON === '1',
  };
}

export interface BuiltClient {
  client: OsdClient;
  config: EnvConfig;
  /** Agent account id the signer acts as (if any). */
  agentId?: string;
  /** Present in mock mode. */
  chain?: MockChain;
}

/**
 * Build a client from EnvConfig. `as: 'agent'` signs with the agent FC key (commit/claim only),
 * `as: 'owner'` with the owner full-access key. Mock mode needs no keys: it signs as the account id.
 */
export function buildClient(config: EnvConfig, as: 'agent' | 'owner' | 'none' = 'agent'): BuiltClient {
  if (config.network === 'mock') {
    const fx = loadFixtures(config.fixturesDir);
    const chain = new MockChain(fx, { contractId: config.contractId });
    if (config.mockOpenSeason) chain.openSeason();
    const agentId = config.agentId ?? (config.agentKeyPath ? loadKeyFile(config.agentKeyPath).account_id : undefined);
    let signer: TxSigner | undefined;
    if (as === 'agent' && agentId) signer = chain.signer(agentId, 'function_call');
    if (as === 'owner' && config.ownerId) signer = chain.signer(config.ownerId, 'full_access');
    const prompts: PromptSource = config.promptsUrl
      ? httpPromptSource(config.promptsUrl)
      : { list: (f) => staticPromptSource(chain.prompts).list(f) };
    return { client: new OsdClient({ contractId: chain.contractId, provider: chain, signer, prompts }), config, agentId, chain };
  }
  const provider = new RpcViewProvider(config.rpcUrl!);
  let signer: TxSigner | undefined;
  let agentId: string | undefined;
  if (as === 'agent' && config.agentKeyPath) {
    const k = loadKeyFile(config.agentKeyPath);
    agentId = config.agentId ?? k.account_id;
    if (!agentId) throw new Error('OSD_AGENT_ID is required (key file has no account_id)');
    signer = agentKeySigner({ agentId, secretKey: k.private_key, contractId: config.contractId, rpc: provider.provider });
  } else if (as === 'agent') agentId = config.agentId;
  if (as === 'owner' && config.ownerKeyPath) {
    const k = loadKeyFile(config.ownerKeyPath);
    const accountId = config.ownerId ?? k.account_id;
    if (!accountId) throw new Error('OSD_OWNER_ID is required (key file has no account_id)');
    signer = fullAccessSigner({ accountId, secretKey: k.private_key, rpc: provider.provider });
  }
  const prompts = config.promptsUrl ? httpPromptSource(config.promptsUrl) : undefined;
  return { client: new OsdClient({ contractId: config.contractId, provider, signer, prompts }), config, agentId };
}
