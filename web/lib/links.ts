export const OUTLAYER_ATTESTATION = (tx: string) => `https://testnet-api.outlayer.ai/attestations/by-tx/${encodeURIComponent(tx)}`;

export function explorerBase(network: 'testnet' | 'mainnet') {
  return network === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io';
}

export const explorerTx = (network: 'testnet' | 'mainnet', tx: string) => `${explorerBase(network)}/txns/${encodeURIComponent(tx)}`;
export const explorerAccount = (network: 'testnet' | 'mainnet', account: string) =>
  `${explorerBase(network)}/address/${encodeURIComponent(account)}`;

/** Agent ids are `<name>.<contract>`; the short name is the URL slug. */
export function agentName(agentId: string, contractId: string): string {
  const suffix = `.${contractId}`;
  return agentId.endsWith(suffix) ? agentId.slice(0, -suffix.length) : agentId;
}

export const agentHref = (name: string) => `/agent/${encodeURIComponent(name)}`;
export const matchHref = (seasonId: number, aName: string, bName: string) =>
  `/match/${seasonId}/${encodeURIComponent(aName)}/${encodeURIComponent(bName)}`;
