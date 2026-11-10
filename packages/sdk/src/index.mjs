// Spike baseline for the OSD SDK (WS3 replaces/extends this).
// Encryption matches interfaces/INTERFACE.md §4 (ECIES secp256k1, eciesjs 0.4.16 defaults).
import { encrypt } from 'eciesjs';
import { createHash } from 'node:crypto';

/** sha256 hex of the UTF-8 prompt; the `prompt_hash` argument of `commit`. */
export function promptHash(prompt) {
  return createHash('sha256').update(Buffer.from(prompt, 'utf8')).digest('hex');
}

/** Encrypt a strategy prompt to the season pubkey (33-byte compressed hex). Returns ciphertext hex. */
export function encryptPrompt(pubkeyHex, prompt) {
  return Buffer.from(encrypt(pubkeyHex, Buffer.from(prompt, 'utf8'))).toString('hex');
}
