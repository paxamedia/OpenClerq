import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only source tests. Without this, a previous `pnpm build:gateway` leaves
    // compiled copies in dist/ that get collected and run as well — stale
    // duplicates that fail against fixtures the source tests have since changed.
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
