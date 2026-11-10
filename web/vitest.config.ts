import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@/': `${import.meta.dirname}/`,
      // `server-only` throws outside React Server Components; tests run lib code directly.
      'server-only': `${import.meta.dirname}/test/server-only-stub.ts`,
    },
  },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
