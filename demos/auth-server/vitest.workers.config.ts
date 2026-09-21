/**
 * The DEPLOYED worker, run in workerd (#1660) — `test/workerd/`, and nothing else.
 *
 * Every other suite here drives `src/routes.ts` on node against a fake `AUTH` namespace, or
 * the issuer on better-sqlite3 — and none of them runs `src/worker.ts` with the real
 * `AuthServerDO`, which is where `/internal/provision` and `/internal/reconcile` actually
 * write. A claim about what those leave in the issuer's SQLite needs the real one.
 *
 * The config is the one `substrat push` builds from: `resolveWranglerConfig` reads
 * `wrangler.jsonc` exactly as the push does, so a binding dropped there is missing here
 * too. `build` is left out on purpose (the SPA — nothing here requests a static file); the
 * worker still imports the inlined-SPA module, so it is generated here — the same idempotent
 * script `pretypecheck` runs, an empty map when no app is built.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { resolveWranglerConfig } from '@substrat-run/cli/dist/push.js';

const here = dirname(fileURLToPath(import.meta.url));
execFileSync(process.execPath, [join(here, 'scripts/gen-assets.mjs')], { stdio: 'ignore' });

const { build: _build, assets: _assets, ...derived } = resolveWranglerConfig(here).cfg;
const config = join(here, 'node_modules/.cache/workerd-test/wrangler.json');
mkdirSync(dirname(config), { recursive: true });
writeFileSync(
  config,
  JSON.stringify({
    ...derived,
    main: resolve(here, String(derived.main)),
    // The two shared secrets the platform and the router present. Test values; a real
    // deploy has its own injected.
    vars: { PLATFORM_SECRET: 'test-platform-secret', ROUTER_SECRET: 'test-router-secret' },
  }),
);

export default defineWorkersConfig({
  test: {
    include: ['test/workerd/**/*.test.ts'],
    testTimeout: 30_000,
    poolOptions: {
      workers: {
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: config },
      },
    },
  },
});
