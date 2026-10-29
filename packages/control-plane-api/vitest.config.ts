import { configDefaults, defineConfig } from 'vitest/config';
import { nodeTestTimeout } from '../../tools/vitest/timeout-policy.mjs';

export default defineConfig({
  test: {
    ...nodeTestTimeout,
    // #113: every refusal a test reaches must be a problem document, or that test fails.
    setupFiles: ['./test/setup/problem-tripwire.ts'],
    // A `*.repo.test.ts` reads the whole workspace, so it runs on every PR in CI's checks job
    // (vitest.repo.config.ts), never again with this package's suite.
    exclude: [...configDefaults.exclude, 'test/**/*.repo.test.ts'],
  },
});
