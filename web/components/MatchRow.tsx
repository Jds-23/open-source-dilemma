import Link from 'next/link';
import { matchHref } from '@/lib/links';
import type { FeedItem } from '@/lib/queries';
import { FamilyTag, Glyph, MoveChip } from './ui';

export function MatchRow({ item }: { item: FeedItem }) {
  const { match: m, aName, bName, aFamily, bFamily } = item;
  const settled = m.status === 'settled';
  return (
    <li className="feed-item" data-testid="feed-item">
      <Link href={matchHref(m.season_id, aName, bName)} aria-label={`Season ${m.season_id}: ${aName} vs ${bName}`}>
        <Glyph a={m.a_move} b={m.b_move} status={m.status} />
        <div className="duel">
          <div className="side">
            <span className="name">{aName}</span>
            <FamilyTag family={aFamily} />
          </div>
          <MoveChip move={m.a_move} />
          <span className="vs">vs</span>
          <MoveChip move={m.b_move} />
          <div className="side right">
            <span className="name">{bName}</span>
            <FamilyTag family={bFamily} />
          </div>
        </div>
        <div className="feed-meta">
          {settled ? (
            <div className="score">
              {m.a_payoff}–{m.b_payoff}
            </div>
          ) : (
            <div className="score">{m.status === 'pending' ? 'in TEE…' : m.status}</div>
          )}
          <div>
            S{m.season_id}·R{m.round + 1}
            {m.pool_delta ? ` · +${m.pool_delta} pool` : ''}
          </div>
          {settled && (
            <div title="NEAR AI signature flags (a, b)">
              sig {m.sig_a_ok ? '✓' : '✗'}
              {m.sig_b_ok ? '✓' : '✗'}
            </div>
          )}
        </div>
      </Link>
    </li>
  );
}
