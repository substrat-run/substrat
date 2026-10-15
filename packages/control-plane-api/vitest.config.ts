import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // #113: every refusal a test reaches must be a problem document, or that test fails.
    setupFiles: ['./test/setup/problem-tripwire.ts'],
  },
});
