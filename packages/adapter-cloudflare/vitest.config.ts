import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// A string, not `new URL(…)`: this config is typechecked with the workers types, whose URL
// is not the one node:url's fileURLToPath takes.
const signedStoreWorker = join(dirname(fileURLToPath(import.meta.url)), 'test', 'signed-store-worker.js');

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
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // #2210: the store is a second script. The key is its var, not the vertical's.
      miniflare: {
        workers: [
          {
            name: 'substrat-store-fixture',
            modules: true,
            scriptPath: signedStoreWorker,
            compatibilityDate: '2025-01-01',
            bindings: { SUBSTRAT_STORE_HMAC_KEY: 'scope-store-test-key' },
          },
        ],
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    // One file at a time, as the old pool's `singleWorker` ran them: several suites count
    // everything in a directory another file's scopes could be written into.
    fileParallelism: false,
    // A rejection nobody handles fails its test; one an RPC caller awaited does not (#2131).
    setupFiles: ['../../tools/vitest/workerd-rejections.mjs'],
  },
});
