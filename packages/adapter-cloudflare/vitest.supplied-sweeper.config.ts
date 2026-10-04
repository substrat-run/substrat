/**
 * The platform-SUPPLIED scope sweeper, run in workerd (#1902) — `supplied-sweeper/`, and nothing
 * else.
 *
 * The fixture vertical (`supplied-sweeper/fixture`) declares schedules and wires no sweeper of
 * its own. Its worker runs as the platform UPLOADS it rather than as its source declares it:
 * `tools/workerd-as-uploaded.mjs` takes the producers — the CLI's declaration, the control
 * plane's push-time decision and `withPlatformEntry` — so the main module is the platform's
 * entry, re-exporting the generated sweeper class, bound as `SWEEPER` with its migration. A
 * pass of THAT class is what the suite runs.
 *
 * Its own config, because the adapter's main suite runs `test/worker.ts`, a different worker.
 * Built output (the CLI and control-plane-api `dist`), like every caller of those packages
 * from a config: run `pnpm build` first.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { asUploaded } from '../../tools/workerd-as-uploaded.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'supplied-sweeper', 'fixture');

// What `substrat push` derives from the fixture's `runtimeNeeds`: its one store, under v1.
const uploaded = await asUploaded(fixture, {
  main: join(fixture, 'worker.ts'),
  compatibility_date: '2025-01-01',
  durable_objects: { bindings: [{ name: 'SCOPE', class_name: 'ScopeDO' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['ScopeDO'] }],
});
const config = join(here, 'node_modules/.cache/supplied-sweeper/wrangler.json');
mkdirSync(dirname(config), { recursive: true });
writeFileSync(
  config,
  JSON.stringify({
    ...uploaded,
    name: 'fixture-scheduled-vertical',
    vars: { ...uploaded.vars, PLATFORM_SECRET: 'test-platform-secret', ROUTER_SECRET: 'test-router-secret' },
  }),
);

export default defineWorkersConfig({
  test: {
    include: ['supplied-sweeper/**/*.test.ts'],
    testTimeout: 30_000,
    poolOptions: {
      workers: {
        // One deployment walked through provision → pass → delete: storage carries across `it`s.
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: config },
      },
    },
  },
});
