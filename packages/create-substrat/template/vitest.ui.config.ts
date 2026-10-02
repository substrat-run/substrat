/**
 * The config behind `pnpm test:ui` — your own `vitest.config.ts`, plus the live test
 * dashboard served on a port Claude Desktop's Browser pane can open (`.claude/launch.json`,
 * the `tests` entry).
 *
 * The UI lives at `/__vitest__/` and the bare origin is a 404, but a launch entry carries
 * a port and never a path, so `/` is redirected to the UI here. `VITEST_UI_PORT` moves
 * the port; it binds 127.0.0.1 only, since the dashboard can re-run your tests.
 */
import { mergeConfig } from 'vitest/config';

import base from './vitest.config.ts';

export default mergeConfig(base, {
  plugins: [
    {
      name: 'substrat:vitest-ui-root',
      configureServer(server: {
        middlewares: {
          use(
            fn: (
              req: { url?: string },
              res: { statusCode: number; setHeader(k: string, v: string): void; end(): void },
              next: () => void,
            ) => void,
          ): void;
        };
      }) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== '/') return next();
          res.statusCode = 302;
          res.setHeader('Location', '/__vitest__/');
          res.end();
        });
      },
    },
  ],
  test: {
    api: { host: '127.0.0.1', port: Number(process.env.VITEST_UI_PORT ?? 5290) },
  },
});
