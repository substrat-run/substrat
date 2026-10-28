/**
 * The fixtures `tools/vitest/workerd-rejections.test.mjs` runs (#2131): small suites that each
 * leave a rejection somewhere the workerd setup file must catch — or, for the twin, must not.
 * They fail on purpose, so this config is never part of `pnpm test`; the node test runs it and
 * reads which files failed. `retry: 2`, because a retry is one of the ways a rejection used to
 * be laundered. The adapter's own test worker, for a real Durable Object to reject.
 */
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { workerdTestTimeout } from '../../tools/vitest/timeout-policy.mjs';

export default defineConfig({
  define: { __PROBE_DO_LIMITS__: 'false', __PROBE_WRITE_REVISION__: 'false' },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    ...workerdTestTimeout,
    // vitest 5.0.4+ turns the module cache on by default, which crashes the workerd pool (WebSocket 1009).
    fsModuleCache: false,
    include: ['rejection-fixtures/**/*.fixture.ts'],
    fileParallelism: false,
    retry: 2,
    setupFiles: ['../../tools/vitest/workerd-rejections.mjs'],
  },
});
