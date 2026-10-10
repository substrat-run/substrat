import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PLATFORM_SWEEP_HOST_KEY, type DeployManifest } from '@substrat-run/contracts';
import { platformSweeperDecision } from '../src/platform-entry.js';

/**
 * The supplied-sweeper refusal (#1646), judged over what a real build of a vertical emits.
 * `platformSweeperDecision` supplies the platform's sweeper only to a bundle that carries the
 * scope-host registry key, and that holds only while the key reaches a bundle exactly when
 * `mountPlatformSurface` does. Whether it does is up to the bundler, not to this repo's
 * source. An unbuilt fixture cannot see that: every hand-written one either has the key or
 * does not. So this bundles two entries with esbuild, the bundler wrangler uses, minified and
 * not. Both import vertical-host. Only one of them mounts the surface.
 *
 * Reads vertical-host's BUILT output, as a push does: run `pnpm build` first.
 */
const here = dirname(fileURLToPath(import.meta.url));

/** `invocationLog` only, the one mount every deployable vertical has (`lint:invocation-log`). */
const LOGS_ONLY = `
import { Hono } from 'hono';
import { invocationLog } from '@substrat-run/vertical-host';
const app = new Hono();
app.use('*', invocationLog({ routerSecret: (env) => env.ROUTER_SECRET }));
export default app;
`;

/** The same, plus the platform surface, which registers the host the supplied sweeper runs. */
const MOUNTS_SURFACE = `
import { Hono } from 'hono';
import { invocationLog, mountPlatformSurface } from '@substrat-run/vertical-host';
const app = new Hono();
app.use('*', invocationLog({ routerSecret: (env) => env.ROUTER_SECRET }));
mountPlatformSurface(app, {
  platformSecret: (env) => env.PLATFORM_SECRET,
  hostFor: (env) => env.HOST,
  roles: [],
  ownerRoleKey: 'owner',
});
export default app;
`;

async function bundled(contents: string, minify: boolean): Promise<string> {
  const result = await build({
    stdin: { contents, resolveDir: here, loader: 'ts', sourcefile: 'worker.ts' },
    bundle: true,
    minify,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    external: ['cloudflare:*', 'node:*'],
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0]!.text;
}

const SCHEDULES: DeployManifest['schedules'] = [{ moduleId: 'm', operation: 'm/tick', cadence: { everyMinutes: 5 }, permissions: [] }];
const decide = (text: string) =>
  platformSweeperDecision(
    { bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }], schedules: SCHEDULES, sweeperClasses: [] },
    { entry: 'worker.js', modules: [{ name: 'worker.js', content: new TextEncoder().encode(text), contentType: 'application/javascript+module' }] },
  );

describe.each([false, true])('a real esbuild bundle of a vertical (minify: %s)', (minify) => {
  it('that imports vertical-host and never mounts the surface carries no key, and is refused', async () => {
    const text = await bundled(LOGS_ONLY, minify);
    // The bundle is a real one: vertical-host's middleware made it in.
    expect(text).toContain('invocation');
    expect(text).not.toContain(PLATFORM_SWEEP_HOST_KEY);
    expect(decide(text)).toEqual({ refuse: expect.stringMatching(/this bundle registers none/) });
  }, 30_000);

  it('that mounts the surface carries the key, and is supplied a sweeper', async () => {
    const text = await bundled(MOUNTS_SURFACE, minify);
    expect(text).toContain(PLATFORM_SWEEP_HOST_KEY);
    expect(decide(text)).toEqual({ supply: true });
  }, 30_000);
});
