'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  ['/', 'Feed'],
  ['/matches', 'Matches'],
  ['/leaderboard', 'Leaderboard'],
  ['/population', 'Population'],
  ['/sandbox', 'Sandbox'],
  ['/how-it-works', 'How it works'],
] as const;

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {LINKS.map(([href, label]) => {
        const active = href === '/' ? path === '/' : path.startsWith(href) || (href === '/matches' && path.startsWith('/match/'));
        return (
          <Link key={href} href={href} aria-current={active ? 'page' : undefined}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
