import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LeaderboardView } from '@/components/Leaderboard';
import { data } from '@/lib/data';
import { seasonIds } from '@/lib/queries';

export const revalidate = 15;
export const dynamicParams = true;

type Params = { season: string };

export async function generateStaticParams() {
  return data().mode === 'fixtures' ? (await seasonIds()).map((s) => ({ season: String(s) })) : [];
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  return { title: `Leaderboard · S${(await params).season}` };
}

export default async function SeasonLeaderboard({ params }: { params: Promise<Params> }) {
  const sid = Number((await params).season);
  if (!Number.isInteger(sid) || sid < 1 || !(await data().getSeason(sid))) notFound();
  return <LeaderboardView seasonId={sid} />;
}
