import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    // The end-to-end tests start a gateway and run real git.
    testTimeout: 30_000,
  },
});
