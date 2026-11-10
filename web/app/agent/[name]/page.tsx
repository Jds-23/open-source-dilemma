import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LineageTree } from '@/components/LineageTree';
import { MatchRow } from '@/components/MatchRow';
import { StrategyCards } from '@/components/StrategyCards';
import { FamilyTag, short } from '@/components/ui';
import { cardsFromEnv } from '@/lib/cards';
import { data } from '@/lib/data';
import { formatAvg } from '@/lib/game';
import { agentName, explorerAccount } from '@/lib/links';
import { allAgentNames, lineageTree, promptFor, type FeedItem } from '@/lib/queries';

export const revalidate = 30;
export const dynamicParams = true;

type Params = { name: string };

export async function generateStaticParams() {
  return data().mode === 'fixtures' ? (await allAgentNames()).map((name) => ({ name })) : [];
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  return { title: decodeURIComponent((await params).name) };
}

export default async function AgentPage({ params }: { params: Promise<Params> }) {
  const name = decodeURIComponent((await params).name);
  if (!/^[a-z0-9_-]{2,16}$/.test(name)) notFound();
  const ds = data();
  const agentId = `${name}.${ds.contractId}`;
  const cardsSrc = cardsFromEnv();
  const [agent, tree, cards] = await Promise.all([
    ds.getAgent(agentId),
    lineageTree(agentId, ds),
    cardsSrc ? cardsSrc.cardsForAgent(agentId) : Promise.resolve([]),
  ]);
  if (!agent && !tree.self.length) notFound();

  const history = tree.self.slice().sort((x, y) => y.season_id - x.season_id);
  const latest = history[0]?.season_id;
  const [season, matches, entries] = latest
    ? await Promise.all([ds.getSeason(latest), ds.getMatches(latest), ds.getEntries(latest)])
    : [null, [], []];
  const fam = new Map(entries.map((e) => [e.agent_id, e.family]));
  const mine: FeedItem[] = matches
    .filter((m) => m.a === agentId || m.b === agentId)
    .map((m) => ({ match: m, aName: agentName(m.a, ds.contractId), bName: agentName(m.b, ds.contractId), aFamily: fam.get(m.a) ?? '?', bFamily: fam.get(m.b) ?? '?' }));

  const prompts = await Promise.all(
    history.map(async (l) => {
      const s = await ds.getSeason(l.season_id);
      const e = (await ds.getEntries(l.season_id)).find((x) => x.agent_id === agentId);
      return { season_id: l.season_id, view: s ? await promptFor(s, e, ds) : ({ state: 'unpublished' } as const) };
    }),
  );

  return (
    <>
      <div className="kicker">Agent</div>
      <h1>{name}</h1>
      <div className="btn-row" style={{ alignItems: 'center', marginBottom: 20 }}>
        {history[0] && <FamilyTag family={history[0].family} />}
        {agent && <span className="tag">owner {agent.owner}</span>}
        <a className="small mono break" href={explorerAccount(ds.network, agentId)} target="_blank" rel="noreferrer">
          {agentId} ↗
        </a>
      </div>

      <div className="grid grid-2">
        <section className="card" aria-labelledby="lin-h">
          <h2 id="lin-h">Lineage</h2>
          <p className="small muted">Each node is one season entry. Children forked from it (the <code>parent</code> link on commit) or re-entered.</p>
          {tree.root ? <LineageTree root={tree.root} selfId={agentId} /> : <p className="muted">No entries yet.</p>}
        </section>
        <section className="card" aria-labelledby="hist-h">
          <h2 id="hist-h">Seasons</h2>
          <div className="table-wrap" style={{ border: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Season</th>
                  <th>Family</th>
                  <th className="num">Rank</th>
                  <th className="num">Avg</th>
                  <th>Commitment</th>
                </tr>
              </thead>
              <tbody>
                {history.map((l) => (
                  <tr key={l.season_id}>
                    <td>
                      <Link href={`/leaderboard/${l.season_id}`}>S{l.season_id}</Link>
                    </td>
                    <td>
                      <FamilyTag family={l.family} />
                    </td>
                    <td className="num">{l.rank ?? '—'}</td>
                    <td className="num">{l.rank ? formatAvg(l.avg_payoff_milli) : '—'}</td>
                    <td className="mono small" title={l.commitment}>
                      {short(l.commitment, 6)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {cardsSrc && cards.length > 0 && <StrategyCards cards={cards} contractId={cardsSrc.contractId} network={ds.network} />}

      <section aria-labelledby="prompts-h">
        <h2 id="prompts-h">Prompts</h2>
        <div className="grid grid-2">
          {prompts.map(({ season_id, view }) => (
            <div key={season_id} className="card">
              <div className="kicker">Season {season_id}</div>
              {view.state === 'revealed' ? (
                <div className="prompt-box">{view.prompt}</div>
              ) : (
                <div className="sealed">
                  🔒{' '}
                  {view.state === 'sealed'
                    ? 'Sealed until the season settles.'
                    : view.state === 'mismatch'
                      ? 'Published text does not match the commitment.'
                      : 'Not published by the owner.'}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {season && (
        <section aria-labelledby="m-h">
          <h2 id="m-h">Season {season.season_id} matches</h2>
          <ul className="feed">
            {mine.map((item) => (
              <MatchRow key={item.match.match_key} item={item} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
