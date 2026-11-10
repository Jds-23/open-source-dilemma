import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Test against the SDK sources so a stale ../sdk/dist never masks a change.
const sdk = (p: string) => fileURLToPath(new URL(`../sdk/src/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@osd\/sdk\/node$/, replacement: sdk('node.ts') },
      { find: /^@osd\/sdk$/, replacement: sdk('index.ts') },
    ],
  },
  test: { include: ['test/**/*.test.ts'] },
});
