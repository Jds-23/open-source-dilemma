import { NextResponse } from 'next/server';
import { playSandbox, validatePrompts } from '@/lib/sandbox';
import { createLimiter, limitMessage } from '@/lib/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Sliding-window limits (5 per 10 min per IP, 200 per day overall) so the shared NEAR AI key can't be drained.
const check = createLimiter();

export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  const v = check(ip);
  if (!v.ok) return NextResponse.json({ error: limitMessage(v) }, { status: 429, headers: { 'retry-after': String(v.retryAfterSec) } });

  let body: { a?: unknown; b?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Expected JSON {a, b}.' }, { status: 400 });
  }
  const err = validatePrompts(body.a, body.b);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  try {
    const result = await playSandbox(body.a as string, body.b as string);
    return NextResponse.json({ ...result, proven: false });
  } catch (e) {
    // Never echo upstream bodies (could include account details); just the status line.
    const msg = e instanceof Error ? e.message : 'referee failed';
    return NextResponse.json({ error: `Referee call failed: ${msg.slice(0, 80)}` }, { status: 502 });
  }
}
