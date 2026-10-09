/**
 * The config behind `pnpm test:ui` — your own `vitest.config.ts`, plus the live test
 * dashboard on a fixed port (`.claude/launch.json`, the `tests` entry).
 *
 * Open it at the URL vitest prints when it starts (`UI started at
 * http://127.0.0.1:5290/__vitest__/?token=…`). The dashboard refuses any request without that
 * token, because its API can re-run your tests, write files and run code; the token is what
 * keeps another page in your browser from driving it. So nothing here redirects the bare
 * origin to it. `VITEST_UI_PORT` moves the port; it binds 127.0.0.1 only. The port is strict:
 * a busy one fails the start rather than moving the dashboard somewhere the launch entry does
 * not point.
 */
import { mergeConfig } from 'vitest/config';

import base from './vitest.config.ts';

export default mergeConfig(base, {
  test: {
    api: {
      host: '127.0.0.1',
      port: Number(process.env.VITEST_UI_PORT ?? 5290),
      strictPort: true,
    },
  },
});
