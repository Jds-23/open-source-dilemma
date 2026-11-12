import { describe, expect, it } from 'vitest';
import { createLimiter } from '@/lib/ratelimit';
import { MAX_PROMPT_BYTES, validatePrompts } from '@/lib/sandbox';

const L = { perIpMax: 5, perIpWindowMs: 600_000, globalMax: 8, globalWindowMs: 86_400_000 };

describe('sandbox rate limit', () => {
  it('blocks the 6th request from one ip, frees after the window', () => {
    let t = 0;
    const check = createLimiter(L, () => t);
    for (let i = 0; i < 5; i++) expect(check('1.1.1.1').ok).toBe(true);
    const v = check('1.1.1.1');
    expect(v).toMatchObject({ ok: false, scope: 'ip' });
    expect(check('2.2.2.2').ok).toBe(true);
    t = 600_001;
    expect(check('1.1.1.1').ok).toBe(true);
  });
  it('enforces the global daily cap', () => {
    const check = createLimiter(L, () => 0);
    for (let i = 0; i < 8; i++) expect(check(`ip${i}`).ok).toBe(true);
    expect(check('other')).toMatchObject({ ok: false, scope: 'global' });
  });
});

describe('prompt cap', () => {
  it('rejects oversize prompts', () => {
    expect(validatePrompts('x'.repeat(MAX_PROMPT_BYTES + 1), 'b')).toMatch(/capped/);
    expect(validatePrompts('a', 'b')).toBeNull();
  });
});
