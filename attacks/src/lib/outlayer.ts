// Direct `outlayer.testnet::request_execution` calls (what the contract's outlayer_call sends).
import { actions } from 'near-api-js';
import { CONTRACT, OUTLAYER, TGAS, milliNear, send, view, type TxOutcome } from './near.ts';
import type { Entry } from './season.ts';

export interface Config {
  owner: string;
  wasm_url: string;
  wasm_hash: string;
  secrets_owner: string;
  secrets_profile: string;
  nearai_signer: string;
}

/**
 * The "wrong wasm": attacks/probe-wasm (built for wasm32-wasip2, uploaded to FastFS by the
 * outsider). It prints only whether PROTECTED_SEASON_SEED / NEARAI_API_KEY reached it.
 */
export const PROBE_WASM = {
  url: 'https://test.fastfs.io/atk7.baldingsucks7993.testnet/outlayer.testnet/osd-attack-probe/v1/b6e46bab964f5b99194ce0b18f1bf28295a54610b22f07f13a0d5a9099989f14.wasm',
  hash: 'b6e46bab964f5b99194ce0b18f1bf28295a54610b22f07f13a0d5a9099989f14',
  upload_tx: 'FFKVE3dRZQ6Kn3aMr4sV49HfsBk7sFJSG1AAuGTvPLdc',
};

export interface ProbeOutput {
  probe: string;
  season_seed_present: boolean;
  nearai_key_present: boolean;
  predecessor: string;
  env_names: string[];
}

export function probeOutput(v: unknown): ProbeOutput | null {
  const o = typeof v === 'string' ? (() => { try { return JSON.parse(v) as unknown; } catch { return null; } })() : v;
  return o && typeof o === 'object' && (o as ProbeOutput).probe === 'osd-attack-5' ? (o as ProbeOutput) : null;
}

export async function config(): Promise<Config> {
  return view<Config>('get_config');
}

/** The play_match input the contract would send for two season-1 entries (the "probe a stored prompt" threat). */
export async function probeInput(seasonId = 1): Promise<Record<string, unknown>> {
  const es = await view<Entry[]>('get_entries', { season_id: seasonId, from_index: 0, limit: 2 });
  const [x, y] = es[0].agent_id < es[1].agent_id ? [es[0], es[1]] : [es[1], es[0]];
  const season = await view<{ params: { referee_template_hash: string; model: string } }>('get_season', { season_id: seasonId });
  return {
    action: 'play_match',
    season: seasonId,
    match_key: `${seasonId}:${x.agent_id}:${y.agent_id}`,
    a: x.agent_id,
    b: y.agent_id,
    ct_a: x.ciphertext_hex,
    ct_b: y.ciphertext_hex,
    hash_a: x.commitment,
    hash_b: y.commitment,
    referee_template_hash: season.params.referee_template_hash,
    params: { model: season.params.model, temperature: 0, seed: 42, max_tokens: 4, enable_thinking: false, max_prompt_bytes: 4000 },
  };
}

export async function requestExecution(
  signer: string,
  o: { wasm: { url: string; hash: string }; input: Record<string, unknown>; secrets?: { profile: string; account_id: string } | null; maxSecs?: number },
): Promise<TxOutcome> {
  const args: Record<string, unknown> = {
    source: { WasmUrl: { url: o.wasm.url, hash: o.wasm.hash, build_target: 'wasm32-wasip2' } },
    resource_limits: { max_instructions: 20_000_000_000, max_memory_mb: 128, max_execution_seconds: o.maxSecs ?? 60 },
    input_data: JSON.stringify(o.input),
    response_format: 'Json',
    payer_account_id: signer,
  };
  if (o.secrets) args.secrets_ref = o.secrets;
  return send(signer, OUTLAYER, [actions.functionCall('request_execution', args, 300n * TGAS, milliNear(30))]);
}

export { CONTRACT };
