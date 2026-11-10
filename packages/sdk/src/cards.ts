// Typed views of the WS-8 strategy cards contract (contracts/cards, NEP-245).
// Card token `s<season>:<agent_id>` (supply 1); season badge `badge:s<season>`.
import type { ViewProvider } from './transport.js';

export interface CardMetadata {
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
  /** Token id of the parent entry's card, when the parent was carded. */
  parent_card: string | null;
  minted_at_ns: string;
}

export interface CardToken {
  token_id: string;
  /** Holder of a supply-1 card; null for badges. */
  owner_id: string | null;
  supply: string;
  metadata: CardMetadata;
}

export const cardTokenId = (seasonId: number, agentId: string): string => `s${seasonId}:${agentId}`;
export const badgeTokenId = (seasonId: number): string => `badge:s${seasonId}`;

export class CardsViews {
  constructor(
    readonly provider: ViewProvider,
    readonly contractId: string,
  ) {}

  private v<T>(method: string, args: object): Promise<T> {
    return this.provider.view(this.contractId, method, args) as Promise<T>;
  }

  mtToken(tokenIds: string[]): Promise<(CardToken | null)[]> {
    return this.v('mt_token', { token_ids: tokenIds });
  }
  async mtBalanceOf(accountId: string, tokenId: string): Promise<bigint> {
    return BigInt(await this.v<string>('mt_balance_of', { account_id: accountId, token_id: tokenId }));
  }
  async mtSupply(tokenId: string): Promise<bigint | null> {
    const s = await this.v<string | null>('mt_supply', { token_id: tokenId });
    return s === null ? null : BigInt(s);
  }
  /** All cards of one agent across seasons, oldest first. */
  cardsForAgent(agentId: string): Promise<CardToken[]> {
    return this.v('cards_for_agent', { agent_id: agentId });
  }
  tokensForOwner(accountId: string, fromIndex = 0, limit = 100): Promise<CardToken[]> {
    return this.v('mt_tokens_for_owner', { account_id: accountId, from_index: String(fromIndex), limit });
  }
}
