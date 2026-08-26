import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The seed builds two full desks through their own operations; the default 5s
    // is not a statement about correctness here.
    testTimeout: 30_000,
  },
});
