import type { Metadata } from 'next';
import { LeaderboardView } from '@/components/Leaderboard';

export const revalidate = 15;
export const metadata: Metadata = { title: 'Leaderboard' };

export default function LeaderboardPage() {
  return <LeaderboardView />;
}
