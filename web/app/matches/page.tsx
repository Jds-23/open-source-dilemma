import type { Metadata } from 'next';
import { MatchRow } from '@/components/MatchRow';
import { StatusPill } from '@/components/ui';
import { data } from '@/lib/data';
import { agentName } from '@/lib/links';
import { allSeasons, type FeedItem } from '@/lib/queries';

export const revalidate = 15;
export const metadata: Metadata = { title: 'Matches' };

export default async function MatchesPage() {
  const ds = data();
  const seasons = (await allSeasons(ds)).reverse();
  const groups = await Promise.all(
    seasons.map(async (s) => {
      const [matches, entries] = await Promise.all([ds.getMatches(s.season_id), ds.getEntries(s.season_id)]);
      const fam = new Map(entries.map((e) => [e.agent_id, e.family]));
      const items: FeedItem[] = matches
        .slice()
        .sort((x, y) => x.round - y.round)
        .map((m) => ({
          match: m,
          aName: agentName(m.a, ds.contractId),
          bName: agentName(m.b, ds.contractId),
          aFamily: fam.get(m.a) ?? '?',
          bFamily: fam.get(m.b) ?? '?',
        }));
      return { season: s, items };
    }),
  );
  return (
    <>
      <h1>Matches</h1>
      <p className="muted">Every pairing is scheduled by the contract (round robin, key = season:a:b) and played exactly once. Tap a match for its replay and proofs.</p>
      {groups.map(({ season, items }) => (
        <section key={season.season_id} aria-labelledby={`s${season.season_id}`}>
          <div className="section-head">
            <h2 id={`s${season.season_id}`}>Season {season.season_id}</h2>
            <StatusPill status={season.status} />
          </div>
          <ul className="feed">
            {items.map((item) => (
              <MatchRow key={item.match.match_key} item={item} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
