// WS-8 strategy cards (contracts/cards, NEP-245), read from NEXT_PUBLIC_CARDS_CONTRACT_ID over JSON-RPC.
// Unset or unreachable -> no cards (the agent page hides the section).

export interface CardToken {
  token_id: string;
  owner_id: string | null;
  supply: string;
  metadata: {
    kind: 'card' | 'badge';
    title: string;
    season_id: number;
    core_contract: string;
    settle_tx: string | null;
    agent_id: string | null;
    family: string | null;
    rank: number | null;
    avg_payoff_milli: number | null;
    commitment: string | null;
    parent_card: string | null;
    minted_at_ns: string;
  };
}

export interface CardsSource {
  contractId: string;
  cardsForAgent(agentId: string): Promise<CardToken[]>;
}

export function cardsFromEnv(env: Record<string, string | undefined> = process.env): CardsSource | null {
  const contractId = env.NEXT_PUBLIC_CARDS_CONTRACT_ID?.trim();
  if (!contractId) return null;
  const network = env.NEXT_PUBLIC_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
  const rpcUrl = env.NEXT_PUBLIC_RPC_URL?.trim() || `https://rpc.${network}.near.org`;
  return {
    contractId,
    async cardsForAgent(agentId) {
      try {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'osd-web-cards',
            method: 'query',
            params: {
              request_type: 'call_function',
              finality: 'final',
              account_id: contractId,
              method_name: 'cards_for_agent',
              args_base64: Buffer.from(JSON.stringify({ agent_id: agentId })).toString('base64'),
            },
          }),
          next: { revalidate: 60 },
        });
        if (!res.ok) return [];
        const body = await res.json();
        if (body.error || body.result?.error || !body.result?.result) return [];
        const cards = JSON.parse(Buffer.from(body.result.result as number[]).toString('utf8')) as CardToken[];
        return cards.filter((c) => c.metadata?.kind === 'card').sort((a, b) => b.metadata.season_id - a.metadata.season_id);
      } catch {
        return [];
      }
    },
  };
}
