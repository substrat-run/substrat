import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // `test/workerd/` runs the deployed worker in workerd — `vitest.workers.config.ts`.
    exclude: [...configDefaults.exclude, 'test/workerd/**'],
  },
});
