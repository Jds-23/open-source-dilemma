import Link from 'next/link';
import { formatAvg } from '@/lib/game';
import { agentHref } from '@/lib/links';
import type { LineageNode } from '@/lib/queries';
import { FamilyTag } from './ui';

function Node({ node, selfId }: { node: LineageNode; selfId: string }) {
  const e = node.entry;
  const self = e.agent_id === selfId;
  return (
    <li>
      <Link href={agentHref(node.name)} className={`node${self ? ' self' : ''}`} aria-current={self ? 'true' : undefined}>
        <span className="s">S{e.season_id}</span>
        <b>{node.name}</b>
        <FamilyTag family={e.family} />
        <span className="s">{e.rank ? `#${e.rank} · ${formatAvg(e.avg_payoff_milli)}` : 'unranked'}</span>
      </Link>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <Node key={`${c.entry.season_id}:${c.entry.agent_id}`} node={c} selfId={selfId} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function LineageTree({ root, selfId }: { root: LineageNode; selfId: string }) {
  return (
    <ul className="tree" data-testid="lineage-tree">
      <Node node={root} selfId={selfId} />
    </ul>
  );
}
