// usage: node encrypt.mjs <pubkey_hex> <agent_id> <prompt text>
//   -> prints JSON {ciphertext_hex, commitment, salt} (random salt; keep it for publish_prompt)
import { sealPrompt } from './index.mjs';
const [pk, agentId, ...rest] = process.argv.slice(2);
if (!pk || !agentId || !rest.length) {
  process.stderr.write('usage: osd-encrypt <pubkey_hex> <agent_id> <prompt text>\n');
  process.exit(2);
}
process.stdout.write(JSON.stringify(sealPrompt(pk, rest.join(' '), agentId)) + '\n');
