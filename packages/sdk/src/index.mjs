// Spike baseline for the OSD SDK (WS3 replaces/extends this).
// Encryption + commitment match interfaces/INTERFACE.md §5 (interfaces-v2).
import { encrypt } from 'eciesjs';
import { createHash, randomBytes } from 'node:crypto';

export const PLAINTEXT_VERSION = 0x01;
export const SALT_BYTES = 32;

const saltBuf = (salt) => {
  const b = Buffer.isBuffer(salt) || salt instanceof Uint8Array ? Buffer.from(salt) : Buffer.from(salt, 'hex');
  if (b.length !== SALT_BYTES) throw new Error(`salt must be ${SALT_BYTES} bytes`);
  return b;
};

/** Fresh random 32-byte salt (hex). */
export function randomSalt() {
  return randomBytes(SALT_BYTES).toString('hex');
}

/** `commitment = sha256(utf8(prompt) || salt[32] || utf8(agent_id))`, lowercase hex. The `commitment` arg of `commit`. */
export function commitment(prompt, saltHex, agentId) {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from(prompt, 'utf8'), saltBuf(saltHex), Buffer.from(agentId, 'utf8')]))
    .digest('hex');
}

/** ECIES plaintext: `0x01 || salt[32] || utf8(prompt)`. */
export function encodePlaintext(prompt, saltHex) {
  return Buffer.concat([Buffer.from([PLAINTEXT_VERSION]), saltBuf(saltHex), Buffer.from(prompt, 'utf8')]);
}

/** Inverse of encodePlaintext. Throws on bad version/length/UTF-8 (the WASM forfeits such an entry). */
export function decodePlaintext(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 1 + SALT_BYTES || b[0] !== PLAINTEXT_VERSION) throw new Error('bad plaintext');
  const prompt = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(1 + SALT_BYTES));
  return { prompt, salt: b.subarray(1, 1 + SALT_BYTES).toString('hex') };
}

/** Encrypt a strategy prompt (+ salt) to the season pubkey (33-byte compressed hex). Returns ciphertext hex. */
export function encryptPrompt(pubkeyHex, prompt, saltHex) {
  return Buffer.from(encrypt(pubkeyHex, encodePlaintext(prompt, saltHex))).toString('hex');
}

/** Everything `commit` needs: `{ciphertext_hex, commitment, salt}`. Keep `salt` to `publish_prompt` later. */
export function sealPrompt(pubkeyHex, prompt, agentId, saltHex = randomSalt()) {
  return { ciphertext_hex: encryptPrompt(pubkeyHex, prompt, saltHex), commitment: commitment(prompt, saltHex, agentId), salt: saltHex };
}
