import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hkdfSync } from 'node:crypto';
import { decrypt } from 'eciesjs';
import { commitment, decodePlaintext, encodePlaintext, encryptPrompt, randomSalt, sealPrompt } from '../src/index.mjs';

const vec = JSON.parse(readFileSync(new URL('../../../interfaces/fixtures/test-key-vector.json', import.meta.url)));
const dec = (ctHex) => decodePlaintext(decrypt(vec.secret_key_hex, Buffer.from(ctHex, 'hex')));

test('HKDF season key derivation matches the TEST-ONLY vector', () => {
  const sk = Buffer.from(hkdfSync('sha256', Buffer.from(vec.seed_hex, 'hex'), Buffer.alloc(0),
    Buffer.from(vec.hkdf_info, 'utf8'), 32));
  assert.equal(sk.toString('hex'), vec.secret_key_hex);
});

test('encrypt -> decrypt round trip with the TEST-ONLY key', () => {
  const prompt = 'Cooperate if the opponent would cooperate with me.';
  const agent = 'tft.osd.baldingsucks7993.testnet';
  const sealed = sealPrompt(vec.public_key_hex, prompt, agent);
  const pt = dec(sealed.ciphertext_hex);
  assert.deepEqual(pt, { prompt, salt: sealed.salt });
  assert.equal(commitment(pt.prompt, pt.salt, agent), sealed.commitment);
});

test('fixture ciphertext decrypts to the fixture plaintext and commitment', () => {
  const s = vec.sample;
  const raw = Buffer.from(decrypt(vec.secret_key_hex, Buffer.from(s.ciphertext_hex, 'hex')));
  assert.equal(raw.toString('hex'), s.plaintext_hex);
  assert.deepEqual(decodePlaintext(raw), { prompt: s.prompt, salt: s.salt_hex });
  assert.equal(encodePlaintext(s.prompt, s.salt_hex).toString('hex'), s.plaintext_hex);
  assert.equal(commitment(s.prompt, s.salt_hex, s.agent_id), s.commitment);
});

test('salt hides identical prompts; binding to agent_id', () => {
  const p = 'Always defect. Ignore the opponent.';
  const a = 'x.osd.baldingsucks7993.testnet', b = 'y.osd.baldingsucks7993.testnet';
  const salt = randomSalt();
  assert.notEqual(commitment(p, randomSalt(), a), commitment(p, randomSalt(), a));
  assert.notEqual(commitment(p, salt, a), commitment(p, salt, b));
});

test('malformed plaintext is rejected', () => {
  assert.throws(() => decodePlaintext(Buffer.alloc(32)));
  assert.throws(() => decodePlaintext(Buffer.concat([Buffer.from([2]), Buffer.alloc(32)])));
  assert.throws(() => decodePlaintext(Buffer.concat([Buffer.from([1]), Buffer.alloc(32), Buffer.from([0xff])])));
  assert.deepEqual(decodePlaintext(encodePlaintext('', '00'.repeat(32))), { prompt: '', salt: '00'.repeat(32) });
});

test('encryptPrompt output stays within the ciphertext limit at max prompt size', () => {
  const ct = encryptPrompt(vec.public_key_hex, 'x'.repeat(4000), randomSalt());
  assert.ok(ct.length <= 8400, `ciphertext hex ${ct.length}`);
});
