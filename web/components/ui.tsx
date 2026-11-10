import Link from 'next/link';
import { familyLabel } from '@/lib/game';
import { agentHref } from '@/lib/links';
import type { Move } from '@/lib/types';

const FAMILY_COLORS: Record<string, string> = {
  tit_for_tat: '#4e79d9',
  fairbot: '#2fae7d',
  prudentbot: '#7fc46a',
  grim: '#8a6fd1',
  always_cooperate: '#5fb8c9',
  always_defect: '#e0533f',
  injector: '#e39a2d',
  injection_defender: '#c46fa8',
  clique: '#a38a5c',
};
const FALLBACK = ['#6c8ebf', '#b0794f', '#5a9e8f', '#b15f7a', '#8f8f3a', '#7a6cb0'];

export function familyColor(f: string): string {
  if (FAMILY_COLORS[f]) return FAMILY_COLORS[f];
  let h = 0;
  for (const ch of f) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}

export function FamilyTag({ family }: { family: string }) {
  return (
    <span className="tag" title={`strategy family: ${family}`}>
      <span className="tag-swatch" style={{ background: familyColor(family) }} aria-hidden />
      {familyLabel(family)}
    </span>
  );
}

export function MoveChip({ move, large }: { move: Move | null; large?: boolean }) {
  const label = move === 'C' ? 'cooperate' : move === 'D' ? 'defect' : move === 'F' ? 'forfeit' : 'no move yet';
  return (
    <span className={`move move-${move ?? 'none'}${large ? ' lg' : ''}`} title={label} aria-label={label}>
      {move ?? '·'}
    </span>
  );
}

/** 2×2 matrix with the realised cell lit: rows = a's move, cols = b's move. */
export function Glyph({ a, b, size = 26, status }: { a: Move | null; b: Move | null; size?: number; status?: string }) {
  const cls = status === 'void' || status === 'refunded' ? 'void' : a === 'F' || b === 'F' ? 'forfeit' : '';
  const cells: Array<[Move, Move, string]> = [
    ['C', 'C', 'cc'],
    ['C', 'D', 'cd'],
    ['D', 'C', 'dc'],
    ['D', 'D', 'dd'],
  ];
  return (
    <span className={`glyph ${cls}`} style={{ width: size, height: size }} aria-hidden>
      {cells.map(([x, y, k]) => (
        <i key={k} className={`${k} ${a === x && b === y ? 'on' : ''}`} />
      ))}
    </span>
  );
}

export function AgentLink({ name }: { name: string }) {
  return (
    <Link href={agentHref(name)} className="name">
      {name}
    </Link>
  );
}

export function StatusPill({ status }: { status: string }) {
  const live = status === 'commit' || status === 'play' || status === 'pending';
  const warn = status === 'void' || status === 'key_failed' || status === 'cancelled';
  return <span className={`pill ${live ? 'live' : warn ? 'warn' : ''}`}>{status.replace('_', ' ')}</span>;
}

export function short(hex: string | null | undefined, n = 8) {
  if (!hex) return '—';
  return hex.length > 2 * n + 1 ? `${hex.slice(0, n)}…${hex.slice(-n)}` : hex;
}
