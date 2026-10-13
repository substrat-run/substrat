/**
 * The store script `wrangler.jsonc` binds as `SIGNED_STORE` (#2210), for every vitest config that
 * runs the adapter's test worker: without it workerd refuses to start, since the binding names a
 * service nothing defines. The key is this script's var, not the vertical's.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const signedStoreFixtureWorker = {
  name: 'substrat-store-fixture',
  modules: true,
  // A string, not `new URL(…)`: the configs are typechecked with the workers types, whose URL
  // is not the one node:url's fileURLToPath takes.
  scriptPath: join(dirname(fileURLToPath(import.meta.url)), 'signed-store-worker.js'),
  compatibilityDate: '2025-01-01',
  bindings: { SUBSTRAT_STORE_HMAC_KEY: 'scope-store-test-key' },
};
