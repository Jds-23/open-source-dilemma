import { FamilyTag, short } from '@/components/ui';
import type { CardToken } from '@/lib/cards';
import { formatAvg } from '@/lib/game';
import { explorerTx } from '@/lib/links';

/** NEP-245 strategy cards minted for this agent (one per settled season). */
export function StrategyCards({ cards, contractId, network }: { cards: CardToken[]; contractId: string; network: 'testnet' | 'mainnet' }) {
  return (
    <section aria-labelledby="cards-h">
      <h2 id="cards-h">Strategy cards</h2>
      <p className="small muted">
        NEP-245 tokens on <span className="mono">{contractId}</span>, minted to the entry owner after the season settled.
      </p>
      <div className="grid grid-3">
        {cards.map((c) => {
          const m = c.metadata;
          return (
            <div key={c.token_id} className="card" data-testid="strategy-card">
              <div className="kicker">Season {m.season_id}</div>
              <div className="btn-row" style={{ alignItems: 'center' }}>
                {m.family && <FamilyTag family={m.family} />}
                <span className="tag">rank {m.rank ?? '—'}</span>
                <span className="tag">avg {m.avg_payoff_milli !== null ? formatAvg(m.avg_payoff_milli) : '—'}</span>
              </div>
              <dl className="small" style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", margin: "12px 0 0" }}>
                <dt className="muted">token</dt>
                <dd style={{ margin: 0 }} className="mono break">{c.token_id}</dd>
                {c.owner_id && (
                  <>
                    <dt className="muted">holder</dt>
                    <dd style={{ margin: 0 }} className="mono break">{c.owner_id}</dd>
                  </>
                )}
                {m.commitment && (
                  <>
                    <dt className="muted">commitment</dt>
                    <dd style={{ margin: 0 }} className="mono" title={m.commitment}>
                      {short(m.commitment, 6)}
                    </dd>
                  </>
                )}
                {m.parent_card && (
                  <>
                    <dt className="muted">parent card</dt>
                    <dd style={{ margin: 0 }} className="mono break">{m.parent_card}</dd>
                  </>
                )}
                {m.settle_tx && (
                  <>
                    <dt className="muted">settled</dt>
                    <dd style={{ margin: 0 }}>
                      <a className="mono" href={explorerTx(network, m.settle_tx)} target="_blank" rel="noreferrer">
                        {short(m.settle_tx, 6)} ↗
                      </a>
                    </dd>
                  </>
                )}
              </dl>
            </div>
          );
        })}
      </div>
    </section>
  );
}
