import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hkdfSync } from 'node:crypto';
import { decrypt } from 'eciesjs';
import { encryptPrompt, promptHash } from '../src/index.mjs';

const vec = JSON.parse(readFileSync(new URL('../../../interfaces/fixtures/test-key-vector.json', import.meta.url)));

test('HKDF season key derivation matches the TEST-ONLY vector', () => {
  const sk = Buffer.from(hkdfSync('sha256', Buffer.from(vec.seed_hex, 'hex'), Buffer.alloc(0),
    Buffer.from(vec.hkdf_info, 'utf8'), 32));
  assert.equal(sk.toString('hex'), vec.secret_key_hex);
});

test('encrypt -> decrypt round trip with the TEST-ONLY key', () => {
  const prompt = 'Cooperate if the opponent would cooperate with me.';
  const ct = encryptPrompt(vec.public_key_hex, prompt);
  const pt = Buffer.from(decrypt(vec.secret_key_hex, Buffer.from(ct, 'hex'))).toString('utf8');
  assert.equal(pt, prompt);
});

test('fixture ciphertext decrypts to the fixture plaintext', () => {
  const pt = Buffer.from(decrypt(vec.secret_key_hex, Buffer.from(vec.sample.ciphertext_hex, 'hex'))).toString('utf8');
  assert.equal(pt, vec.sample.plaintext);
  assert.equal(promptHash(pt), vec.sample.prompt_hash);
});
