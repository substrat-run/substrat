/**
 * The DEPLOYED worker, run in workerd (#1646) — `test/workerd/`, and nothing else.
 *
 * Every other suite here drives the module on the node host, where `server.ts` runs the
 * platform sweep on a timer — so none of them could see that the hosted worker ran no
 * schedules at all. This one runs `src/worker.ts`.
 *
 * The config is the one `substrat push` builds from: `resolveWranglerConfig` reads
 * `wrangler.jsonc` exactly as the push does, so a store dropped there is a binding missing
 * here too. Two things are left out, both on purpose: `build` (the SPA — nothing here
 * requests a static file) and `assets` (the push reads those itself and never hands them
 * to wrangler).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { resolveWranglerConfig } from '@substrat-run/cli/dist/push.js';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * The entitlements a dashboard install projects into a new scope: what package.json
 * declares, else the bare slug (apps/dashboard `installEntitlements`). The suite's
 * standard-install case provisions with exactly these, so the scope enforces them the way
 * a real install does (#304, #443).
 */
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')) as {
  substrat: { slug: string; entitlements?: string[] };
};
const installEntitlements = pkg.substrat.entitlements?.length ? pkg.substrat.entitlements : [pkg.substrat.slug];

const { build: _build, assets: _assets, ...derived } = resolveWranglerConfig(here).cfg;
const config = join(here, 'node_modules/.cache/workerd-test/wrangler.json');
mkdirSync(dirname(config), { recursive: true });
writeFileSync(
  config,
  JSON.stringify({
    ...derived,
    main: resolve(here, String(derived.main)),
    // The two shared secrets the platform and the router present, and the version the
    // deploy injects (#1242). Test values; a real deploy injects its own.
    vars: {
      PLATFORM_SECRET: 'test-platform-secret',
      ROUTER_SECRET: 'test-router-secret',
      SUBSTRAT_VERSION_ID: '01JTESTVRSN0000000000000M0',
      // Read by the suite only — the worker never looks at it.
      TEST_INSTALL_ENTITLEMENTS: JSON.stringify(installEntitlements),
    },
  }),
);

export default defineWorkersConfig({
  test: {
    include: ['test/workerd/**/*.test.ts'],
    testTimeout: 30_000,
    poolOptions: {
      workers: {
        // The suite walks one deployment through provision → due work → sweep → delete,
        // so storage must carry across `it` blocks.
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: config },
      },
    },
  },
});
