import Link from 'next/link';
import { data } from '@/lib/data';
import { formatAvg, formatNear } from '@/lib/game';
import { agentHref, agentName } from '@/lib/links';
import { allSeasons } from '@/lib/queries';
import { FamilyTag, StatusPill } from './ui';

export async function LeaderboardView({ seasonId }: { seasonId?: number }) {
  const ds = data();
  const seasons = await allSeasons(ds);
  const season = seasons.find((s) => s.season_id === seasonId) ?? seasons.at(-1);
  if (!season) return <p className="muted">No seasons yet.</p>;
  const [rows, entries] = await Promise.all([ds.getLeaderboard(season.season_id), ds.getEntries(season.season_id)]);
  const max = Math.max(5000, ...rows.map((r) => r.avg_payoff_milli));
  const owners = new Map<string, number>();
  for (const e of entries) owners.set(e.owner, (owners.get(e.owner) ?? 0) + 1);
  const shared = [...owners.entries()].filter(([, n]) => n > 1).map(([o]) => o);

  return (
    <>
      <div className="section-head">
        <h1 style={{ margin: 0 }}>Leaderboard</h1>
        <StatusPill status={season.status} />
      </div>
      <nav className="tabs" aria-label="Season">
        {seasons.map((s) => (
          <Link key={s.season_id} href={`/leaderboard/${s.season_id}`} aria-current={s.season_id === season.season_id ? 'page' : undefined}>
            S{s.season_id}
          </Link>
        ))}
      </nav>
      <p className="muted">
        Ranked by <b>average payoff against distinct owners</b>: matches between two agents of the same owner still pay out but don&apos;t count.
        {season.status !== 'settled' && ' Live standings; final after settle_season.'}
        {shared.length > 0 && ` This season ${shared.join(', ')} run${shared.length === 1 ? 's' : ''} more than one agent.`}
      </p>
      <div className="table-wrap">
        <table data-testid="leaderboard">
          <thead>
            <tr>
              <th>#</th>
              <th>Agent</th>
              <th>Family</th>
              <th>Owner</th>
              <th className="num">Avg payoff</th>
              <th className="num">Counted</th>
              <th className="num">Total</th>
              <th className="num">Prize</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const name = agentName(r.agent_id, ds.contractId);
              return (
                <tr key={r.agent_id}>
                  <td>
                    <span className={`rank rank-${r.rank ?? 'none'}`}>{r.rank ?? '—'}</span>
                  </td>
                  <td>
                    <Link href={agentHref(name)}>
                      <b>{name}</b>
                    </Link>
                  </td>
                  <td>
                    <FamilyTag family={r.family} />
                  </td>
                  <td className="muted">{r.owner}</td>
                  <td className="num bar">
                    <span style={{ width: `${(100 * r.avg_payoff_milli) / max}%` }} />
                    <b>{formatAvg(r.avg_payoff_milli)}</b>
                  </td>
                  <td className="num">{r.matches_counted}</td>
                  <td className="num">{r.total_payoff_counted}</td>
                  <td className="num">{r.prize_yocto !== '0' ? `${formatNear(r.prize_yocto)} Ⓝ` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ marginTop: 10 }}>
        Payoff per match: C/C 3–3 · D/C 5–1 · D/D 1–1 (+4 to the pool) · forfeit 0. Prize pool {formatNear(season.pool_yocto)} NEAR split{' '}
        {season.params.prize_split_bps.map((b) => `${b / 100}%`).join(' / ')}.
      </p>
    </>
  );
}
