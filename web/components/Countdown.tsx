'use client';
import { useEffect, useState } from 'react';

function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d > 0 ? `${d}d ` : ''}${pad(h)}:${pad(m)}:${pad(sec)}`;
}

/** Counts down to `targetMs` (epoch ms). Renders a stable placeholder on the server to avoid hydration drift. */
export function Countdown({ targetMs, doneLabel = 'deadline passed' }: { targetMs: number; doneLabel?: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);
  const iso = new Date(targetMs).toISOString();
  if (now === null) return <time className="countdown" dateTime={iso}>--:--:--</time>;
  const left = targetMs - now;
  return (
    <time className="countdown" dateTime={iso} data-testid="countdown">
      {left > 0 ? fmt(left) : doneLabel}
    </time>
  );
}
