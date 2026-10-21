import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Push command cases launch child processes and now bundle the Worker during preflight.
    testTimeout: 15_000,
  },
});
