import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { workerdTestTimeout } from '../../tools/vitest/timeout-policy.mjs';

export default defineConfig({
  // `process.env` inside workerd is not the runner's, so an opt-in from the environment is decided
  // here. `SUBSTRAT_PROBE_DO_LIMITS=1` runs the exhaustive limit measurement (test/do-sql-limits.test.ts).
  // `SUBSTRAT_PROBE_WRITE_REVISION=1` runs #1722's write-revision cost measurement (test/write-revision-cost.test.ts).
  // `SUBSTRAT_PROBE_SCOPE_WORK=1` runs #3316's scope-work meter overhead measurement (test/scope-work.test.ts).
  // `SUBSTRAT_PROBE_SAMPLED_COPY=1` runs #3232's rows-written measurement, whole vs sampled (test/sampled-copy.test.ts).
  // `SUBSTRAT_PROBE_DIRECTORY_MIRROR=1` runs K-68 step 3b's rows-written measurement (test/directory-mirror.test.ts).
  define: {
    __PROBE_DO_LIMITS__: JSON.stringify(process.env.SUBSTRAT_PROBE_DO_LIMITS === '1'),
    __PROBE_WRITE_REVISION__: JSON.stringify(process.env.SUBSTRAT_PROBE_WRITE_REVISION === '1'),
    __PROBE_SCOPE_WORK__: JSON.stringify(process.env.SUBSTRAT_PROBE_SCOPE_WORK === '1'),
    __PROBE_SAMPLED_COPY__: JSON.stringify(process.env.SUBSTRAT_PROBE_SAMPLED_COPY === '1'),
    __PROBE_DIRECTORY_MIRROR__: JSON.stringify(process.env.SUBSTRAT_PROBE_DIRECTORY_MIRROR === '1'),
  },
  // The contract suites carry state across `it` blocks (e.g. a guard write read back by a later
  // test), and the plugin never rolls storage back per test. Fresh scope/tenant ids per suite
  // (ulid) keep suites isolated.
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    ...workerdTestTimeout,
    // vitest 5.0.4+ turns the module cache on by default, which crashes the workerd pool (WebSocket 1009).
    fsModuleCache: false,
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    // One file at a time, as the old pool's `singleWorker` ran them: several suites count
    // everything in a directory another file's scopes could be written into.
    fileParallelism: false,
    // A rejection nobody handles fails its test; one an RPC caller awaited does not (#2131).
    setupFiles: ['../../tools/vitest/workerd-rejections.mjs'],
  },
});
