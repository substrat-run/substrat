import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A `*.repo.test.ts` reads the whole workspace, so it runs on every PR in CI's checks job
    // (vitest.repo.config.ts), never again with this package's suite.
    exclude: [...configDefaults.exclude, 'test/**/*.repo.test.ts'],
  },
});
