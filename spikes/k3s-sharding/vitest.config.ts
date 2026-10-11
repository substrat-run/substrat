import { defineConfig } from 'vitest/config';

/**
 * What `pnpm test` runs, and so what CI runs whenever a change reaches the kernel, the sqlite
 * adapter, the todo demo or the contract suites: the files with no race against real time.
 * Placement is pure; the lease and contract files spawn only the control plane, on a manual
 * clock; the storage fence is one process.
 *
 * The cluster files (`vitest.cluster.config.ts`, `pnpm test:cluster`) are opt-in. They drive
 * real shard processes through freezes and kills with real lease TTLs and router timeouts,
 * and a loaded runner can move their timings, so they are run on purpose, not on every PR.
 */
export default defineConfig({
  test: {
    include: ['test/placement.test.ts', 'test/lease.test.ts', 'test/storage-fence.test.ts', 'test/contract.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
