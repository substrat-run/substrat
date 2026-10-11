import { defineConfig } from 'vitest/config';

/**
 * `pnpm test:cluster`: the multi-process runs — control plane, shards and routers as real
 * processes, faults fired by the shards on themselves, real lease TTLs. Opt-in, so a slow CI
 * runner never turns their timing into a flaky PR (see `vitest.config.ts`). One file at a
 * time, and every hook bounded: a cluster that cannot come up or go down fails its file.
 */
export default defineConfig({
  test: {
    include: [
      'test/kill.test.ts',
      'test/router.test.ts',
      'test/background.test.ts',
      'test/reshard.test.ts',
      'test/control-plane-loss.test.ts',
    ],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
