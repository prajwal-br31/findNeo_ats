import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    /*
     * Phase 0 shares one test database, so files must not overlap. T-011
     * replaces this with template-database restore per test (11 §2), at which
     * point files can run in parallel again.
     */
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
