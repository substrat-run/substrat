import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // `test/workerd/` runs the deployed worker in workerd — `vitest.workers.config.ts`.
    exclude: [...configDefaults.exclude, 'test/workerd/**'],
    // The seed builds two full desks through their own operations; the default 5s
    // is not a statement about correctness here.
    testTimeout: 30_000,
    // The module's `ctx.log` lines (#1747) go to the console by default, as they do in
    // production, and the seed alone writes hundreds. A suite that asserts on them passes
    // its own sink to `buildHost`; everywhere else they are noise in the test output.
    onConsoleLog: (log) => (log.startsWith('{"substrat":"log"') ? false : undefined),
  },
});
