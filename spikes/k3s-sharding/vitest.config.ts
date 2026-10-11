import { defineConfig } from 'vitest/config';

// The suites spawn real processes (control plane, shards, routers). One file at a time, so two
// clusters never compete for a slow runner, and every hook is bounded: a cluster that cannot
// come up or go down fails the file instead of hanging it.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
