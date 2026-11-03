/**
 * #2351: the control plane reads a version's migrations by evaluating its bundle in a Worker
 * Loader isolate with no bindings and no network. Here on a real bundle — the fixture vertical's
 * entry, built as a push builds it — through control-plane-api's own extractor, so a scope host
 * whose module top level needed a binding, or whose class lost the marker, fails here.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { registeredMigrationsOf } from '@substrat-run/kernel';
import { loaderMigrationExtractor, PLATFORM_ENTRY_MODULE, type MigrationLoader } from '@substrat-run/control-plane-api';
import { MODULES } from './fixture/perms.js';

const { MIGRATION_LOADER, FIXTURE_ENTRY_BUNDLE } = env as unknown as { MIGRATION_LOADER: MigrationLoader; FIXTURE_ENTRY_BUNDLE: string };
const js = (name: string, source: string) => ({ name, content: new TextEncoder().encode(source), contentType: 'application/javascript+module' });
const extract = loaderMigrationExtractor(MIGRATION_LOADER);
const bundleOf = (...modules: ReturnType<typeof js>[]) => ({ entry: 'worker.js', compatibilityDate: '2025-01-01', compatibilityFlags: [], modules });

describe('reading the migrations a bundle registers (#2351)', () => {
  it('reads what the bundle’s scope host registers, from a push and from its archive script alike', async () => {
    const registered = registeredMigrationsOf(MODULES);
    expect(registered.length).toBeGreaterThan(0);
    expect(await extract(bundleOf(js('worker.js', FIXTURE_ENTRY_BUNDLE)))).toEqual(registered);
    // An archive script carries the platform's entry beside the vertical's: it is left out.
    expect(await extract(bundleOf(js(PLATFORM_ENTRY_MODULE, 'throw new Error("not the vertical")'), js('worker.js', FIXTURE_ENTRY_BUNDLE)))).toEqual(registered);
  });

  it('a bundle exposing no registrations (an adapter from before them) reads as null', async () => {
    expect(await extract(bundleOf(js('worker.js', 'export class ScopeDO {} export default {}')))).toBeNull();
  });

  it.each([
    ['reaches the network', 'await fetch("https://example.com/");'],
    ['reads a binding', 'import { env } from "cloudflare:workers"; env.DB.prepare("SELECT 1");'],
  ])('a bundle whose top level %s is refused with the sentence that says so', async (_what, source) => {
    await expect(extract(bundleOf(js('worker.js', `${source}\nexport default {}`)))).rejects.toThrow(
      /^the worker entry could not be evaluated without its bindings: /,
    );
  });
});
