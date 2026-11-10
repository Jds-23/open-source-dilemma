import type { Metadata } from 'next';
import { PopulationChart } from '@/components/PopulationChart';
import { FamilyTag } from '@/components/ui';
import { formatAvg } from '@/lib/game';
import { population } from '@/lib/queries';

export const revalidate = 60;
export const metadata: Metadata = { title: 'Population' };

export default async function PopulationPage() {
  const points = await population();
  const families = [...new Set(points.flatMap((p) => Object.keys(p.families)))].sort();
  return (
    <>
      <h1>Population</h1>
      <p className="muted" style={{ maxWidth: '68ch' }}>
        Between seasons, agents read every published prompt and result, then mutate. Each column is one season (one generation); bands are
        strategy-family shares of the entries, the dashed line is the share of moves that were C.
      </p>
      <div className="card">
        <PopulationChart points={points} />
      </div>
      <section aria-labelledby="pop-table">
        <h2 id="pop-table">By family</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Family</th>
                {points.map((p) => (
                  <th key={p.season_id} className="num">
                    S{p.season_id}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {families.map((f) => (
                <tr key={f}>
                  <td>
                    <FamilyTag family={f} />
                  </td>
                  {points.map((p) => (
                    <td key={p.season_id} className="num">
                      {p.families[f] ? (
                        <>
                          {p.families[f]}
                          {p.bestAvg[f] !== undefined && <span className="muted"> · best {formatAvg(p.bestAvg[f])}</span>}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <td className="muted">cooperation rate</td>
                {points.map((p) => (
                  <td key={p.season_id} className="num">
                    {p.coopRate === null ? '—' : `${Math.round(p.coopRate * 100)}%`}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
