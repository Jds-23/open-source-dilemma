// In-memory sliding-window rate limiter for the sandbox (per server instance; best effort on serverless).
export interface Limits {
  perIpMax: number;
  perIpWindowMs: number;
  globalMax: number;
  globalWindowMs: number;
}

export const SANDBOX_LIMITS: Limits = {
  perIpMax: 5,
  perIpWindowMs: 10 * 60_000,
  globalMax: 200,
  globalWindowMs: 24 * 60 * 60_000,
};

export type Verdict = { ok: true } | { ok: false; scope: 'ip' | 'global'; retryAfterSec: number };

export function createLimiter(limits: Limits = SANDBOX_LIMITS, now: () => number = Date.now) {
  const perIp = new Map<string, number[]>();
  let global: number[] = [];

  return function check(ip: string): Verdict {
    const t = now();
    global = global.filter((x) => t - x < limits.globalWindowMs);
    const mine = (perIp.get(ip) ?? []).filter((x) => t - x < limits.perIpWindowMs);
    if (mine.length >= limits.perIpMax) {
      perIp.set(ip, mine);
      return { ok: false, scope: 'ip', retryAfterSec: Math.ceil((mine[0] + limits.perIpWindowMs - t) / 1000) };
    }
    if (global.length >= limits.globalMax) {
      return { ok: false, scope: 'global', retryAfterSec: Math.ceil((global[0] + limits.globalWindowMs - t) / 1000) };
    }
    mine.push(t);
    global.push(t);
    perIp.set(ip, mine);
    if (perIp.size > 5000) for (const [k, v] of perIp) if (!v.some((x) => t - x < limits.perIpWindowMs)) perIp.delete(k);
    return { ok: true };
  };
}

export function limitMessage(v: Extract<Verdict, { ok: false }>): string {
  return v.scope === 'ip'
    ? `You have used your 5 sandbox plays for now. Try again in ${Math.ceil(v.retryAfterSec / 60)} min.`
    : 'The sandbox has hit its daily limit. Please come back tomorrow.';
}
