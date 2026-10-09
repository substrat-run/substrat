import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `process.env` inside workerd is not the runner's, so an opt-in from the environment is decided
  // here. `SUBSTRAT_PROBE_DO_LIMITS=1` runs the exhaustive limit measurement (test/do-sql-limits.test.ts).
  // `SUBSTRAT_PROBE_WRITE_REVISION=1` runs #1722's write-revision cost measurement (test/write-revision-cost.test.ts).
  define: {
    __PROBE_DO_LIMITS__: JSON.stringify(process.env.SUBSTRAT_PROBE_DO_LIMITS === '1'),
    __PROBE_WRITE_REVISION__: JSON.stringify(process.env.SUBSTRAT_PROBE_WRITE_REVISION === '1'),
  },
  // The contract suites carry state across `it` blocks (e.g. a guard write read back by a later
  // test), and the plugin never rolls storage back per test. Fresh scope/tenant ids per suite
  // (ulid) keep suites isolated.
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: {
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    // One file at a time, as the old pool's `singleWorker` ran them: several suites count
    // everything in a directory another file's scopes could be written into.
    fileParallelism: false,
    // workerd reports a Durable Object RPC rejection as "Uncaught (in promise)" on the server side
    // even when the caller awaits it and asserts `.rejects`; the plugin's node-compat `process`
    // events now hand those reports to vitest. Printed, not failed: parity with the old pool (#2131).
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
