// Pure game rules from INTERFACE.md §2 and §7. No I/O; shared by the data layer, pages, sandbox and tests.
import type { Entry, LeaderboardRow, Match, Move } from './types';

/** Payoff units per side: [a, b, pool]. INTERFACE.md §2. */
export function payoff(a: Move, b: Move): [number, number, number] {
  if (a === 'F' && b === 'F') return [0, 0, 6];
  if (a === 'F') return [0, 3, 3];
  if (b === 'F') return [3, 0, 3];
  if (a === 'C' && b === 'C') return [3, 3, 0];
  if (a === 'D' && b === 'C') return [5, 1, 0];
  if (a === 'C' && b === 'D') return [1, 5, 0];
  return [1, 1, 4];
}

/** Strict referee reply parser (INTERFACE.md §8): first C/D after trim+uppercase, else D. */
export function parseMove(reply: string | null | undefined): 'C' | 'D' {
  const t = (reply ?? '').trim().toUpperCase();
  for (const ch of t) {
    if (ch === 'C' || ch === 'D') return ch;
  }
  return 'D';
}

export function outcomeLabel(a: Move | null, b: Move | null): string {
  if (!a || !b) return '—';
  if (a === 'C' && b === 'C') return 'Mutual cooperation';
  if (a === 'D' && b === 'D') return 'Mutual defection';
  if (a === 'F' || b === 'F') return 'Forfeit';
  return 'Exploitation';
}

/**
 * Ranking (INTERFACE.md §7): counted = settled matches vs a different owner; avg = floor(1000 Σ / n);
 * sort avg desc, total desc, then commit order. Agents with 0 counted matches get rank null.
 * Prizes are not computed here (only the contract pays); rows carry prize "0".
 */
export function rankSeason(entries: Entry[], matches: Match[]): LeaderboardRow[] {
  const owner = new Map(entries.map((e) => [e.agent_id, e.owner]));
  const stats = new Map(entries.map((e) => [e.agent_id, { n: 0, total: 0 }]));
  for (const m of matches) {
    if (m.status !== 'settled') continue;
    if (owner.get(m.a) === owner.get(m.b)) continue;
    const sa = stats.get(m.a);
    const sb = stats.get(m.b);
    if (sa) {
      sa.n += 1;
      sa.total += m.a_payoff;
    }
    if (sb) {
      sb.n += 1;
      sb.total += m.b_payoff;
    }
  }
  const rows = entries.map((e, order) => {
    const s = stats.get(e.agent_id)!;
    return {
      order,
      row: {
        agent_id: e.agent_id,
        owner: e.owner,
        family: e.family,
        matches_counted: s.n,
        total_payoff_counted: s.total,
        avg_payoff_milli: s.n ? Math.floor((1000 * s.total) / s.n) : 0,
        rank: null as number | null,
        prize_yocto: '0',
      },
    };
  });
  rows.sort(
    (x, y) =>
      Number(y.row.matches_counted > 0) - Number(x.row.matches_counted > 0) ||
      y.row.avg_payoff_milli - x.row.avg_payoff_milli ||
      y.row.total_payoff_counted - x.row.total_payoff_counted ||
      x.order - y.order,
  );
  let r = 0;
  for (const { row } of rows) row.rank = row.matches_counted > 0 ? ++r : null;
  return rows.map((x) => x.row);
}

/** Cooperation rate over settled matches: share of C moves among all C/D/F moves. */
export function cooperationRate(matches: Match[]): number | null {
  let c = 0;
  let n = 0;
  for (const m of matches) {
    if (m.status !== 'settled' || !m.a_move || !m.b_move) continue;
    n += 2;
    c += Number(m.a_move === 'C') + Number(m.b_move === 'C');
  }
  return n ? c / n : null;
}

// ---------- commitment (INTERFACE.md §5) ----------

export function hexToBytes(hex: string): Uint8Array {
  if (!/^([0-9a-f]{2})*$/i.test(hex)) throw new Error('bad hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesToHex(b: ArrayBuffer | Uint8Array): string {
  return Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

/** sha256_hex(utf8(prompt) || salt[32] || utf8(agent_id)) */
export async function computeCommitment(prompt: string, saltHex: string, agentId: string): Promise<string> {
  const enc = new TextEncoder();
  const p = enc.encode(prompt);
  const s = hexToBytes(saltHex);
  if (s.length !== 32) throw new Error('salt must be 32 bytes');
  const a = enc.encode(agentId);
  const buf = new Uint8Array(p.length + s.length + a.length);
  buf.set(p, 0);
  buf.set(s, p.length);
  buf.set(a, p.length + s.length);
  return sha256Hex(buf);
}

export async function verifyCommitment(prompt: string, saltHex: string, agentId: string, commitment: string) {
  try {
    return (await computeCommitment(prompt, saltHex, agentId)) === commitment.toLowerCase();
  } catch {
    return false;
  }
}

// ---------- units ----------

const YOCTO = 10n ** 24n;

/** yoctoNEAR decimal string → "1.22" style NEAR string (up to `dp` decimals, trailing zeros trimmed). */
export function formatNear(yocto: string | null | undefined, dp = 3): string {
  if (!yocto) return '0';
  const v = BigInt(yocto);
  const whole = v / YOCTO;
  const frac = (v % YOCTO).toString().padStart(24, '0').slice(0, dp).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function nsToDate(ns: string | null | undefined): Date | null {
  if (!ns) return null;
  return new Date(Number(BigInt(ns) / 1_000_000n));
}

export function formatAvg(milli: number): string {
  return (milli / 1000).toFixed(2);
}

/** Display form of a family tag: `tit_for_tat` → `tit for tat`. */
export function familyLabel(f: string): string {
  return f.replace(/_/g, ' ');
}
