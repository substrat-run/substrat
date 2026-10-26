import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The `*.workerd.test.ts` suites boot a real workerd through Miniflare (~4 s alone, the first
    // time a worker is addressed); under CI load that overran the 5 s default (#2584). The same
    // value the other workerd suites carry.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
