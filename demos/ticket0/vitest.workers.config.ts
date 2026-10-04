/**
 * The DEPLOYED worker, run in workerd (#1646) — `test/workerd/`, and nothing else.
 *
 * Every other suite in this package drives the module on the node host, which is why
 * none of them could see that a hosted desk's schedules never fire: the timer that fires
 * them lives in `src/worker.ts`, and nothing ran that file.
 *
 * There is no wrangler config to point at — this vertical declares `runtimeNeeds` and the
 * CLI derives one inside a push (`src/worker.ts` header). So the suite takes the SAME
 * derivation (`resolveWranglerConfig`, the code `substrat push` runs) rather than a copy:
 * a store dropped from package.json is a binding missing here too, and the suite goes red
 * instead of the first provision in production. Two things are left out, both on purpose:
 * `build` (the SPA — nothing here requests a static file) and `assets` (the push reads
 * those itself and never hands them to wrangler).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { resolveWranglerConfig } from '@substrat-run/cli/dist/push.js';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * The entitlements a dashboard install projects into a new desk: what package.json
 * declares, else the bare slug (apps/dashboard `installEntitlements`). The suite provisions
 * with exactly these, so the scope enforces them the way a real desk does (#304, #443) —
 * a schedule that needed a key the install never grants would fail here as it would there.
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
    // The one field NOT taken from the derivation. The platform baseline is newer than the
    // workerd this pool bundles can run (it falls back to its own latest), and at those
    // dates workerd serves real `node:vm`/`node:console` modules that shadow the pool
    // runner's own shims, so the runner cannot start. 2025-01-01 is the date every other
    // workerd suite in the repo runs at; what this suite proves — the roster, the alarm
    // pass, the schedules' effects — does not turn on a compatibility flag.
    compatibility_date: '2025-01-01',
    // The two shared secrets the platform and the router present, and the version the
    // deploy injects (#1242). Test values; a real deploy injects its own.
    vars: {
      PLATFORM_SECRET: 'test-platform-secret',
      ROUTER_SECRET: 'test-router-secret',
      SUBSTRAT_VERSION_ID: '01JTESTVRSN0000000000000T0',
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
