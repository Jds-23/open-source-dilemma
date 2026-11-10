// Season-key encryption + salted commitment (INTERFACE.md §5, interfaces-v2).
// Isomorphic: @noble/hashes + eciesjs, no node:crypto.
import { encrypt } from 'eciesjs';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils';
import { MAX_CIPHERTEXT_HEX, MAX_PROMPT_BYTES } from './constants.js';

export const PLAINTEXT_VERSION = 0x01;
export const SALT_BYTES = 32;

export type Bytes = Uint8Array;
export type SaltInput = string | Uint8Array;

const HEX_RE = /^[0-9a-f]*$/;
const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;

function saltBytes(salt: SaltInput): Bytes {
  let b: Bytes;
  if (typeof salt === 'string') {
    if (!HEX_RE.test(salt)) throw new Error('salt must be lowercase hex');
    b = hexToBytes(salt);
  } else b = Uint8Array.from(salt);
  if (b.length !== SALT_BYTES) throw new Error(`salt must be ${SALT_BYTES} bytes`);
  return b;
}

export { bytesToHex, hexToBytes };

/** Lowercase hex sha256. */
export function sha256Hex(data: Bytes | string): string {
  return bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data));
}

/** Fresh CSPRNG 32-byte salt, hex. */
export function randomSalt(): string {
  return bytesToHex(randomBytes(SALT_BYTES));
}

/** `commitment = sha256(utf8(prompt) || salt[32] || utf8(agent_id))`, lowercase hex (the `commitment` arg of `commit`). */
export function commitment(prompt: string, salt: SaltInput, agentId: string): string {
  return sha256Hex(concatBytes(utf8ToBytes(prompt), saltBytes(salt), utf8ToBytes(agentId)));
}

/** True iff `(prompt, salt)` opens `expected` for `agentId`. */
export function verifyCommitment(prompt: string, salt: SaltInput, agentId: string, expected: string): boolean {
  try {
    return commitment(prompt, salt, agentId) === expected;
  } catch {
    return false;
  }
}

/** ECIES plaintext: `0x01 || salt[32] || utf8(prompt)`. */
export function encodePlaintext(prompt: string, salt: SaltInput): Bytes {
  return concatBytes(Uint8Array.of(PLAINTEXT_VERSION), saltBytes(salt), utf8ToBytes(prompt));
}

/** Inverse of encodePlaintext. Throws on bad version/length/UTF-8 (the WASM forfeits such an entry). */
export function decodePlaintext(bytes: Bytes): { prompt: string; salt: string } {
  const b = Uint8Array.from(bytes);
  if (b.length < 1 + SALT_BYTES || b[0] !== PLAINTEXT_VERSION) throw new Error('bad plaintext');
  const prompt = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(1 + SALT_BYTES));
  return { prompt, salt: bytesToHex(b.subarray(1, 1 + SALT_BYTES)) };
}

/** Throws if the prompt exceeds the 4000-byte cap. */
export function assertPromptSize(prompt: string): void {
  const n = utf8ToBytes(prompt).length;
  if (n > MAX_PROMPT_BYTES) throw new Error(`prompt is ${n} bytes; max ${MAX_PROMPT_BYTES}`);
}

/** Encrypt `0x01 || salt || prompt` to the season pubkey (33-byte compressed, 66 hex). Returns ciphertext hex. */
export function encryptPrompt(pubkeyHex: string, prompt: string, salt: SaltInput): string {
  if (!PUBKEY_RE.test(pubkeyHex)) throw new Error('season pubkey must be 66 lowercase hex chars (compressed secp256k1)');
  assertPromptSize(prompt);
  const ct = bytesToHex(encrypt(pubkeyHex, encodePlaintext(prompt, salt)));
  if (ct.length > MAX_CIPHERTEXT_HEX) throw new Error(`ciphertext_hex is ${ct.length} chars; max ${MAX_CIPHERTEXT_HEX}`);
  return ct;
}

export interface SealedPrompt {
  ciphertext_hex: string;
  commitment: string;
  /** 64 hex. Keep it: needed for `publish_prompt`. Revealing it during the commit window lets others test prompt guesses. */
  salt: string;
}

/** Everything `commit` needs. `salt` defaults to a fresh random one. */
export function sealPrompt(pubkeyHex: string, prompt: string, agentId: string, salt: SaltInput = randomSalt()): SealedPrompt {
  const saltHex = typeof salt === 'string' ? salt : bytesToHex(salt);
  return {
    ciphertext_hex: encryptPrompt(pubkeyHex, prompt, saltHex),
    commitment: commitment(prompt, saltHex, agentId),
    salt: saltHex,
  };
}
