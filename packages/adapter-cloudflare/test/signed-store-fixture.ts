/**
 * The store script `wrangler.jsonc` binds as `SIGNED_STORE` (#2210), for every vitest config that
 * runs the adapter's test worker: without it workerd refuses to start, since the binding names a
 * service nothing defines. The key is this script's var, and the calling test worker has none.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const signedStoreFixtureWorker = {
  name: 'substrat-store-fixture',
  // Listed rather than discovered: the fixture imports contracts' built MAC module (a zero-import
  // subpath) by a relative path, and workerd resolves it only if the module is declared. Paths
  // are strings, not `new URL(…)`: the configs are typechecked with the workers types, whose URL
  // is not the one node:url's fileURLToPath takes.
  modulesRoot: PACKAGES,
  modules: [
    { type: 'ESModule' as const, path: join(PACKAGES, 'adapter-cloudflare', 'test', 'signed-store-worker.js') },
    { type: 'ESModule' as const, path: join(PACKAGES, 'contracts', 'dist', 'scope-store-mac.js') },
  ],
  compatibilityDate: '2025-01-01',
  bindings: { SUBSTRAT_STORE_HMAC_KEY: 'scope-store-test-key' },
};
