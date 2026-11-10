import { familyLabel } from '@/lib/game';
import type { PopulationPoint } from '@/lib/queries';
import { familyColor } from './ui';

/** Stacked share-of-population columns per season, with the cooperation rate as a line on top. Pure SVG. */
export function PopulationChart({ points }: { points: PopulationPoint[] }) {
  const families = [...new Set(points.flatMap((p) => Object.keys(p.families)))].sort();
  const W = 720;
  const H = 300;
  const pad = { l: 40, r: 16, t: 16, b: 36 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const n = Math.max(points.length, 1);
  const slot = iw / n;
  const bw = Math.min(90, slot * 0.62);
  const x = (i: number) => pad.l + slot * i + slot / 2;
  const y = (v: number) => pad.t + ih * (1 - v);
  const coop = points.map((p, i) => (p.coopRate === null ? null : ([x(i), y(p.coopRate)] as const))).filter(Boolean) as Array<readonly [number, number]>;

  return (
    <figure className="chart" style={{ margin: 0 }} data-testid="population-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Strategy family share per season, with cooperation rate">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeDasharray={t ? '2 4' : undefined} />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end">
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          let acc = 0;
          return (
            <g key={p.season_id}>
              {families.map((f) => {
                const v = (p.families[f] ?? 0) / (p.total || 1);
                if (!v) return null;
                acc += v;
                return (
                  <rect key={f} x={x(i) - bw / 2} width={bw} y={y(acc)} height={ih * v} fill={familyColor(f)} stroke="var(--surface)" strokeWidth={1.5} rx={2}>
                    <title>{`S${p.season_id} ${familyLabel(f)}: ${p.families[f]} of ${p.total} (${Math.round(v * 100)}%)`}</title>
                  </rect>
                );
              })}
              <text x={x(i)} y={H - pad.b + 16} textAnchor="middle">
                S{p.season_id}
                {p.status !== 'settled' ? '*' : ''}
              </text>
              <text x={x(i)} y={H - pad.b + 30} textAnchor="middle">
                n={p.total}
              </text>
            </g>
          );
        })}
        {coop.length > 1 && (
          <polyline points={coop.map(([a, b]) => `${a},${b}`).join(' ')} fill="none" stroke="var(--text)" strokeWidth={2} strokeDasharray="5 4" />
        )}
        {coop.map(([a, b], i) => (
          <circle key={i} cx={a} cy={b} r={4} fill="var(--bg)" stroke="var(--text)" strokeWidth={2} />
        ))}
      </svg>
      <figcaption className="legend">
        {families.map((f) => (
          <span key={f}>
            <span className="tag-swatch" style={{ background: familyColor(f) }} aria-hidden />
            {familyLabel(f)}
          </span>
        ))}
        <span>
          <svg width="22" height="8" aria-hidden style={{ verticalAlign: 'middle', marginRight: 5 }}>
            <line x1="0" x2="22" y1="4" y2="4" stroke="var(--text)" strokeWidth="2" strokeDasharray="5 4" />
          </svg>
          cooperation rate
        </span>
        {points.some((p) => p.status !== 'settled') && <span className="muted">* season in progress</span>}
      </figcaption>
    </figure>
  );
}
