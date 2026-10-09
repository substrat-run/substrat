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
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { asUploaded } from '../../tools/workerd-as-uploaded.mjs';
import { defineConfig } from 'vitest/config';

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

export default defineConfig({
  // One deployment walked through provision → pass → delete: storage carries across `it`s.
  plugins: [cloudflareTest({ wrangler: { configPath: config } })],
  test: {
    include: ['supplied-sweeper/**/*.test.ts'],
    testTimeout: 30_000,
    // One file at a time, as the old pool's `singleWorker` ran them.
    fileParallelism: false,
    // workerd reports a Durable Object RPC rejection as "Uncaught (in promise)" on the server side
    // even when the caller awaits it and asserts `.rejects`; the plugin's node-compat `process`
    // events now hand those reports to vitest. Printed, not failed: parity with the old pool (#2131).
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
