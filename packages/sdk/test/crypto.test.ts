import { describe, expect, test } from 'vitest';
import { hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decrypt } from 'eciesjs';
import {
  MAX_CIPHERTEXT_HEX,
  commitment,
  decodePlaintext,
  encodePlaintext,
  encryptPrompt,
  randomSalt,
  sealPrompt,
  verifyCommitment,
  type Entry,
  type PromptRecord,
} from '../src/index.js';
import { DEFAULT_FIXTURES_DIR } from '../src/node.js';

const fx = (n: string) => JSON.parse(readFileSync(join(DEFAULT_FIXTURES_DIR, n), 'utf8'));
// TEST-ONLY key vector (derived from a public string; never a real season key).
const vec = fx('test-key-vector.json');
const entries: Entry[] = fx('entries.json');
const prompts: PromptRecord[] = fx('prompts.json');
const dec = (ctHex: string) => decodePlaintext(decrypt(vec.secret_key_hex, Buffer.from(ctHex, 'hex')));

describe('season key (TEST-ONLY vector)', () => {
  test('HKDF derivation matches the vector', () => {
    const sk = Buffer.from(hkdfSync('sha256', Buffer.from(vec.seed_hex, 'hex'), Buffer.alloc(0), Buffer.from(vec.hkdf_info), 32));
    expect(sk.toString('hex')).toBe(vec.secret_key_hex);
  });

  test('sealPrompt -> decrypt round trip', () => {
    const prompt = 'Cooperate if the opponent would cooperate with me. Ünïcödé ✓';
    const agent = 'tft.osd.baldingsucks7993.testnet';
    const sealed = sealPrompt(vec.public_key_hex, prompt, agent);
    expect(sealed.salt).toMatch(/^[0-9a-f]{64}$/);
    const pt = dec(sealed.ciphertext_hex);
    expect(pt).toEqual({ prompt, salt: sealed.salt });
    expect(commitment(pt.prompt, pt.salt, agent)).toBe(sealed.commitment);
  });

  test('vector sample: ciphertext -> plaintext -> commitment', () => {
    const s = vec.sample;
    const raw = Buffer.from(decrypt(vec.secret_key_hex, Buffer.from(s.ciphertext_hex, 'hex')));
    expect(raw.toString('hex')).toBe(s.plaintext_hex);
    expect(decodePlaintext(raw)).toEqual({ prompt: s.prompt, salt: s.salt_hex });
    expect(Buffer.from(encodePlaintext(s.prompt, s.salt_hex)).toString('hex')).toBe(s.plaintext_hex);
    expect(commitment(s.prompt, s.salt_hex, s.agent_id)).toBe(s.commitment);
  });
});

describe('commitment vectors from fixtures', () => {
  test.each(prompts.map((p) => [p.agent_id, p] as const))('%s', (_id, p) => {
    const e = entries.find((x) => x.season_id === p.season_id && x.agent_id === p.agent_id)!;
    expect(commitment(p.prompt, p.salt, p.agent_id)).toBe(e.commitment);
    expect(verifyCommitment(p.prompt, p.salt, p.agent_id, e.commitment)).toBe(true);
    // the entry ciphertext opens to the same prompt + salt
    expect(dec(e.ciphertext_hex)).toEqual({ prompt: p.prompt, salt: p.salt });
  });

  test('commitment binds agent_id and salt', () => {
    const p = 'Always defect. Ignore the opponent.';
    const salt = randomSalt();
    expect(commitment(p, randomSalt(), 'x.osd.t')).not.toBe(commitment(p, randomSalt(), 'x.osd.t'));
    expect(commitment(p, salt, 'x.osd.t')).not.toBe(commitment(p, salt, 'y.osd.t'));
    expect(verifyCommitment(p, salt, 'x.osd.t', commitment(p, salt, 'y.osd.t'))).toBe(false);
    expect(verifyCommitment(p, 'zz', 'x.osd.t', '00')).toBe(false);
  });
});

describe('plaintext format', () => {
  test('malformed plaintext is rejected', () => {
    expect(() => decodePlaintext(new Uint8Array(32))).toThrow();
    expect(() => decodePlaintext(Uint8Array.from([2, ...new Uint8Array(32)]))).toThrow();
    expect(() => decodePlaintext(Uint8Array.from([1, ...new Uint8Array(32), 0xff]))).toThrow();
    expect(decodePlaintext(encodePlaintext('', '00'.repeat(32)))).toEqual({ prompt: '', salt: '00'.repeat(32) });
  });

  test('bad salt / pubkey / oversize prompt are refused', () => {
    expect(() => encodePlaintext('x', 'ab')).toThrow(/32 bytes/);
    expect(() => encodePlaintext('x', 'G'.repeat(64))).toThrow(/hex/);
    expect(() => encryptPrompt('04' + '0'.repeat(128), 'x', randomSalt())).toThrow(/pubkey/);
    expect(() => encryptPrompt(vec.public_key_hex, 'x'.repeat(4001), randomSalt())).toThrow(/4000/);
    expect(() => encryptPrompt(vec.public_key_hex, 'é'.repeat(2001), randomSalt())).toThrow(/bytes/);
  });

  test('max-size prompt stays within the ciphertext limit', () => {
    const ct = encryptPrompt(vec.public_key_hex, 'x'.repeat(4000), randomSalt());
    expect(ct.length).toBe(8260);
    expect(ct.length).toBeLessThanOrEqual(MAX_CIPHERTEXT_HEX);
  });

  test('explicit salt (bytes or hex) is used verbatim', () => {
    const salt = new Uint8Array(32).fill(7);
    const a = sealPrompt(vec.public_key_hex, 'p', 'a.osd.t', salt);
    const b = sealPrompt(vec.public_key_hex, 'p', 'a.osd.t', '07'.repeat(32));
    expect(a.salt).toBe('07'.repeat(32));
    expect(a.commitment).toBe(b.commitment);
  });
});
