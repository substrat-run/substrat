import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // `test/workerd/` runs the deployed worker in workerd — `vitest.workers.config.ts`.
    exclude: [...configDefaults.exclude, 'test/workerd/**'],
    // The seed builds two full desks through their own operations; the default 5s
    // is not a statement about correctness here.
    testTimeout: 30_000,
  },
});
