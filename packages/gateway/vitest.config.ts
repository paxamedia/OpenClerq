import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only source tests. Without this, a previous `pnpm build:gateway` leaves
    // compiled copies in dist/ that get collected and run as well — stale
    // duplicates that fail against fixtures the source tests have since changed.
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    // The integration suite drives real sockets and a deliberately slow fake
    // provider. Five seconds is ample on a laptop and marginal on a loaded CI
    // runner; a passing test is not slowed by a higher ceiling.
    testTimeout: 20_000,
  },
});
