import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  // #1758 bisect: `process.env` inside workerd is not the runner's, so a CI-only skip is decided here.
  define: { __BISECT_SKIP_1758__: JSON.stringify(Boolean(process.env.CI)) },
  test: {
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    poolOptions: {
      workers: {
        // The contract suites carry state across `it` blocks (e.g. a guard write
        // read back by a later test), so storage must NOT be rolled back per
        // test. Fresh scope/tenant ids per suite (ulid) keep suites isolated.
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
  },
});
