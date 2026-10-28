import { defineConfig } from 'vitest/config';
import { nodeTestTimeout } from '../../tools/vitest/timeout-policy.ts';

export default defineConfig({
  test: { ...nodeTestTimeout, include: ['test/**/*.test.ts'] },
});
