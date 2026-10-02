/**
 * The config behind every demo's `test:ui` (#756): the demo's own `vitest.config.ts`
 * (when it has one), plus one plugin.
 *
 * The vitest UI is served at `/__vitest__/`, and the bare origin is a 404. The Browser pane
 * opens a launch entry's origin and `.claude/launch.json` carries a port, not a path, so
 * without this the pane lands on a 404 page. `/` redirects to the UI instead.
 *
 * Read from the demo's directory (`pnpm run` sets the cwd to the package), which is how one
 * file serves nine demos without each of them gaining a config of its own.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const UI_PATH = '/__vitest__/';

const redirectRootToUi = {
  name: 'substrat:vitest-ui-root',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url !== '/') return next();
      res.statusCode = 302;
      res.setHeader('Location', UI_PATH);
      res.end();
    });
  },
};

const own = join(process.cwd(), 'vitest.config.ts');
const base = existsSync(own) ? (await import(pathToFileURL(own).href)).default : {};
if (typeof base === 'function') {
  throw new Error(`${own} exports a function; ui.config.mjs merges plain config objects only.`);
}

export default { ...base, plugins: [...(base.plugins ?? []), redirectRootToUi] };
