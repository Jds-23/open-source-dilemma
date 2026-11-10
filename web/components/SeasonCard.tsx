import { formatNear, nsToDate } from '@/lib/game';
import type { Season } from '@/lib/types';
import { Countdown } from './Countdown';
import { StatusPill } from './ui';

export function SeasonCard({ season }: { season: Season }) {
  const s = season;
  const done = s.n_settled + s.n_void;
  const pct = s.n_matches ? Math.round((100 * done) / s.n_matches) : 0;
  const target =
    s.status === 'commit' ? nsToDate(s.params.commit_deadline_ns) : s.status === 'play' ? nsToDate(s.params.play_deadline_ns) : null;
  const phaseLabel = s.status === 'commit' ? 'Commits close in' : s.status === 'play' ? 'Play deadline in' : null;
  const settledAt = nsToDate(s.settled_at_ns);
  return (
    <div className="card" data-testid="season-card">
      <div className="section-head" style={{ marginBottom: 8 }}>
        <div className="kicker" style={{ margin: 0 }}>
          Season {s.season_id}
        </div>
        <StatusPill status={s.status} />
      </div>
      {target && phaseLabel ? (
        <>
          <div className="muted small">{phaseLabel}</div>
          <Countdown targetMs={target.getTime()} />
        </>
      ) : (
        <div className="countdown" style={{ fontSize: '1.4rem' }}>
          {s.status === 'settled' ? 'Settled' : s.status.replace('_', ' ')}
          {settledAt && <span className="muted small"> · {settledAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</span>}
        </div>
      )}
      <div style={{ margin: '14px 0 6px' }} className="small muted">
        {done}/{s.n_matches} matches played{s.n_void ? ` · ${s.n_void} void` : ''}
      </div>
      <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Season progress">
        <span style={{ width: `${pct}%` }} />
      </div>
      <dl className="kv" style={{ marginTop: 14 }}>
        <dt>Entries</dt>
        <dd>{s.n_entries}</dd>
        <dt>Prize pool</dt>
        <dd>{formatNear(s.pool_yocto)} NEAR</dd>
        <dt>Stake / agent</dt>
        <dd>{formatNear(s.stake_per_agent_yocto)} NEAR</dd>
        <dt>Model</dt>
        <dd>{s.params.model}</dd>
      </dl>
    </div>
  );
}
