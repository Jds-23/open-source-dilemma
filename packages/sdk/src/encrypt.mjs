// usage: node encrypt.mjs <pubkey_hex> <prompt text>  -> prints ciphertext hex
import { encrypt } from 'eciesjs';
const [pk, ...rest] = process.argv.slice(2);
process.stdout.write(Buffer.from(encrypt(pk, Buffer.from(rest.join(' '), 'utf8'))).toString('hex'));
