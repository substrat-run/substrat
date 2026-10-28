/**
 * The engine on the Durable-Object host — `test/workerd/`, and nothing else.
 *
 * The node suites prove the engine's logic on SQLite; this proves its SQL where it runs in
 * production: the migrations, the UNIQUE and CHECK constraints, the list index the kernel
 * derives from `paged.over`, the digest schedule's read and delete of what was held, the
 * erasure's deletes, and the settle that writes the outcome event back, all executed by a real
 * ScopeDO in workerd.
 */
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { workerdTestTimeout } from '../../tools/vitest/timeout-policy.mjs';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './test/workerd/wrangler.jsonc' } })],
  test: {
    ...workerdTestTimeout,
    // vitest 5.0.4+ turns the module cache on by default, which crashes the workerd pool (WebSocket 1009).
    fsModuleCache: false,
    include: ['test/workerd/**/*.test.ts'],
    // One deployment walked through its whole life: storage carries across `it` blocks.
    fileParallelism: false,
    // A rejection nobody handles fails its test; one an RPC caller awaited does not (#2131).
    setupFiles: ['../../tools/vitest/workerd-rejections.mjs'],
  },
});
