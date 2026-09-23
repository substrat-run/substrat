import { defineConfig } from 'vitest/config';
// The web workspace owns its DOM suite and jsdom environment separately.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
