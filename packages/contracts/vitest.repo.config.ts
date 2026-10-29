import { defineConfig } from 'vitest/config';

// The repo-wide checks this package holds (`pnpm lint:store-driver-repository`, CI's checks job).
export default defineConfig({
  test: {
    include: ['test/**/*.repo.test.ts'],
  },
});
