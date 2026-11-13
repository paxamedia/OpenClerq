import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Real processes (git, sandbox-exec, fake runtimes) start slowly while
    // every package's tests run at once; 5s is too tight then.
    testTimeout: 20_000,
    exclude: ['dist/**', 'node_modules/**'],
  },
});
