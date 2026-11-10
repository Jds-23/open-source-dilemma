// Types for the spike-baseline @osd/sdk (plain .mjs). Delete once WS3 ships typings.
declare module '@osd/sdk' {
  export function sealPrompt(pubkeyHex: string, prompt: string, agentId: string, saltHex?: string): { ciphertext_hex: string; commitment: string; salt: string };
  export function commitment(prompt: string, saltHex: string, agentId: string): string;
  export function decodePlaintext(bytes: Uint8Array): { prompt: string; salt: string };
}
