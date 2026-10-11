import { defineConfig } from 'vitest/config';
// The app workspace (`app/`) owns its DOM suite and jsdom environment separately (#119).
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
