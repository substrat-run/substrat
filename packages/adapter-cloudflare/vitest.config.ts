import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  // `process.env` inside workerd is not the runner's, so an opt-in from the environment is decided
  // here. `SUBSTRAT_PROBE_DO_LIMITS=1` runs the exhaustive limit measurement (test/do-sql-limits.test.ts).
  // `SUBSTRAT_PROBE_WRITE_REVISION=1` runs #1722's write-revision cost measurement (test/write-revision-cost.test.ts).
  define: {
    __PROBE_DO_LIMITS__: JSON.stringify(process.env.SUBSTRAT_PROBE_DO_LIMITS === '1'),
    __PROBE_WRITE_REVISION__: JSON.stringify(process.env.SUBSTRAT_PROBE_WRITE_REVISION === '1'),
  },
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
