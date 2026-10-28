import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { nodeTestTimeout } from '../../../tools/vitest/timeout-policy.mjs';

export default defineConfig({
  plugins: [react()],
  test: {
    ...nodeTestTimeout,
    environment: 'jsdom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
