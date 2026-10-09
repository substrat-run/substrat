/**
 * The config behind every demo's `test:ui` (#756): the demo's own `vitest.config.ts`
 * (when it has one), unchanged.
 *
 * Open the UI at the URL vitest prints when it starts (`UI started at
 * http://127.0.0.1:<port>/__vitest__/?token=…`). vitest 5 refuses `/__vitest__/` without that
 * token (403), and nothing here redirects to it: the token is what stops another local page,
 * or a DNS-rebinding one, from driving vitest's API — which can write files and run code — so
 * a redirect that handed it out at `/` would undo it (#2129).
 *
 * Read from the demo's directory (`pnpm run` sets the cwd to the package), which is how one
 * file serves nine demos without each of them gaining a config of its own.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const own = join(process.cwd(), 'vitest.config.ts');
const base = existsSync(own) ? (await import(pathToFileURL(own).href)).default : {};
if (typeof base === 'function') {
  throw new Error(`${own} exports a function; ui.config.mjs merges plain config objects only.`);
}

export default base;
