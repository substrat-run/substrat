import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The 50-byte LIKE/GLOB pattern limit a Durable Object enforces (#1770) — on by
    // default, so a scaffolded project's own suite sees what production sees.
    setupFiles: ['./test/setup.ts'],
  },
});
