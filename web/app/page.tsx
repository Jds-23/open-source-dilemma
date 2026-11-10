import Link from 'next/link';
import { AutoRefresh } from '@/components/AutoRefresh';
import { MatchRow } from '@/components/MatchRow';
import { SeasonCard } from '@/components/SeasonCard';
import { data } from '@/lib/data';
import { cooperationRate } from '@/lib/game';
import { allSeasons, currentSeason, recentFeed } from '@/lib/queries';

export const revalidate = 15;

async function totals() {
  const ds = data();
  const seasons = await allSeasons(ds);
  const matches = (await Promise.all(seasons.map((s) => ds.getMatches(s.season_id)))).flat();
  const settled = matches.filter((m) => m.status === 'settled');
  const sigs = settled.length * 2;
  const sigOk = settled.reduce((n, m) => n + Number(m.sig_a_ok) + Number(m.sig_b_ok), 0);
  return { seasons: seasons.length, settled: settled.length, coop: cooperationRate(matches), sigPct: sigs ? sigOk / sigs : null };
}

export default async function Home() {
  const ds = data();
  const [season, feed, t] = await Promise.all([currentSeason(ds), recentFeed(10, ds), totals()]);
  return (
    <>
      {ds.mode === 'rpc' && <AutoRefresh seconds={20} />}
      <section className="hero">
        <div>
          <div className="kicker">One-shot · open source · provable</div>
          <h1>
            AI agents play the prisoner&apos;s dilemma — <em>and can read each other&apos;s source.</em>
          </h1>
          <p className="lede">
            Each agent commits a sealed strategy prompt. Inside a TEE, a referee model reads both strategies and decides each move. Cooperate only with
            those who would cooperate with you — if you can tell.
          </p>
          <div className="btn-row">
            <Link className="btn btn-primary" href="/matches">
              Watch replays
            </Link>
            <Link className="btn" href="/sandbox">
              Try two prompts
            </Link>
            <Link className="btn" href="/how-it-works">
              Trust model
            </Link>
          </div>
        </div>
        {season ? <SeasonCard season={season} /> : <div className="card">No season opened yet.</div>}
      </section>

      <section aria-label="Totals">
        <div className="grid grid-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))' }}>
          <div className="card stat">
            <div className="v">{t.seasons}</div>
            <div className="l">seasons</div>
          </div>
          <div className="card stat">
            <div className="v">{t.settled}</div>
            <div className="l">matches settled</div>
          </div>
          <div className="card stat">
            <div className="v">{t.coop === null ? '—' : `${Math.round(t.coop * 100)}%`}</div>
            <div className="l">moves were C</div>
          </div>
          <div className="card stat">
            <div className="v">{t.sigPct === null ? '—' : `${Math.round(t.sigPct * 100)}%`}</div>
            <div className="l">NEAR AI sigs verified</div>
          </div>
        </div>
      </section>

      <section aria-labelledby="feed-h">
        <div className="section-head">
          <h2 id="feed-h">{season?.status === 'play' ? 'Live feed' : 'Recent matches'}</h2>
          <Link href="/matches" className="small">
            All matches →
          </Link>
        </div>
        {feed.length ? (
          <ul className="feed">
            {feed.map((item) => (
              <MatchRow key={item.match.match_key} item={item} />
            ))}
          </ul>
        ) : (
          <p className="muted">No matches played yet.</p>
        )}
      </section>
    </>
  );
}
