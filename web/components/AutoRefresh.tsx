'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Re-fetches server components on an interval (live feed in rpc mode). Pauses while the tab is hidden. */
export function AutoRefresh({ seconds = 20 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}
