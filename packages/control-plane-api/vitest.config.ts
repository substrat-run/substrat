import { defineConfig } from 'vitest/config';
import { nodeTestTimeout } from '../../tools/vitest/timeout-policy.mjs';

export default defineConfig({
  test: {
    ...nodeTestTimeout,
    // #113: every refusal a test reaches must be a problem document, or that test fails.
    setupFiles: ['./test/setup/problem-tripwire.ts'],
  },
});
