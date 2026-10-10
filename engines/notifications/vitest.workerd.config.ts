/**
 * The engine on the Durable-Object host — `test/workerd/`, and nothing else.
 *
 * The node suites prove the engine's logic on SQLite; this proves its SQL where it runs in
 * production: the migration, the UNIQUE and CHECK constraints, the list index the kernel
 * derives from `paged.over`, the erasure's delete, and the settle that writes the outcome
 * event back, all executed by a real ScopeDO in workerd.
 */
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './test/workerd/wrangler.jsonc' } })],
  test: {
    include: ['test/workerd/**/*.test.ts'],
    testTimeout: 30_000,
    // One deployment walked through its whole life: storage carries across `it` blocks.
    fileParallelism: false,
    // A rejection nobody handles fails its test; one an RPC caller awaited does not (#2131).
    setupFiles: ['../../tools/vitest/workerd-rejections.mjs'],
  },
});
