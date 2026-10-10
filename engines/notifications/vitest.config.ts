import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // test/workerd runs inside workerd (vitest.workerd.config.ts), not node.
    exclude: [...configDefaults.exclude, 'test/workerd/**'],
  },
});
