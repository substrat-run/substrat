import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // No Web Awesome control is registered in a suite: jsdom has no form validation for them to
    // call, a `wa-*` tag stays a plain element holding its light DOM, and that is what is read.
    alias: [
      {
        find: /^@awesome\.me\/webawesome\/dist\/components\/.*/,
        replacement: fileURLToPath(new URL('./test/no-control.ts', import.meta.url)),
      },
    ],
  },
});
