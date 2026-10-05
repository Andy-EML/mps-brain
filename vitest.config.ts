import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/worker/src/**/*.test.ts',
      'apps/worker/scripts/**/*.test.ts',
      'apps/web/src/**/*.test.ts',
    ],
    testTimeout: 30_000,
    // PGlite cold start can be slow when many test files spin up their own instance in the same
    // combined run (T11/T17 notes, TEST-REPORT-2026-09-18.md #4). The default 10s hook timeout
    // occasionally trips beforeEach() on this machine; these files pass alone. Raised, not removed,
    // so a genuinely hung hook still fails the suite.
    hookTimeout: 60_000,
  },
});
