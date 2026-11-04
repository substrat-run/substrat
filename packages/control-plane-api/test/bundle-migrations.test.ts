import { createControlPlaneApi } from './setup/build-fixtures.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { migrationDigestOf, platformActorId, tenantId, type DeclaredMigration } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import {
  DEV_ACTOR_HEADER,
  extractedMigrationsDigest,
  loaderMigrationExtractor,
  MigrationExtractionError,
  MigrationLoaderUnavailable,
  readExtraction,
  type MigrationLoader,
  UNSAFE_devPlatformActorAuth,
  type ExtractMigrationsFn,
} from '../src/index.js';

/**
 * #2351: the control plane reads a version's migrations from its bundle (`extractMigrations`, a
 * Worker Loader in production, faked here; the loader itself is driven in workerd on a real bundle by
 * adapter-cloudflare's `supplied-sweeper/bundle-migrations.test.ts`) and gates the push on them, through the real
 * deploy and promote routes over the pure host.
 */
const m = (version: string, sql: string, extra: Partial<DeclaredMigration> = {}) =>
  ({ moduleId: 'acme-crm', version, sql, ...extra }) as DeclaredMigration;
const declared = [m('0001-init', 'CREATE TABLE contacts (id TEXT PRIMARY KEY);'), m('0002-note', 'ALTER TABLE contacts ADD COLUMN note TEXT;')];
/** The digest a version whose bundle registers `declared` records. */
const DECLARED_DIGEST = await extractedMigrationsDigest(declared);
const failed = (): never => {
  throw new MigrationExtractionError('the worker entry could not be evaluated without its bindings: env.DB is undefined');
};

describe('a version’s migrations, read from its bundle (#2351)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  const staff = platformActorId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff };
  const deployVertical = vi.fn(async () => {});
  /** What the bundle under test registers: the extractor's answer, or a throw. */
  let registers: ExtractMigrationsFn = async () => declared;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-bundle-migrations-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      deployVertical,
      extractMigrations: (bundle) => registers(bundle),
      fetchVerticalModules: async () => [
        { name: 'worker.js', content: new TextEncoder().encode('export default {}'), contentType: 'application/javascript+module' },
      ],
    });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const push = async (slug: string, migrations: DeclaredMigration[] | undefined) => {
    await host.admin.createTenant(staff, { id: tenantId.parse(ulid()), slug, name: slug });
    const fd = new FormData();
    fd.set(
      'manifest',
      JSON.stringify({
        version: '0.1.0',
        entry: 'worker.js',
        compatibilityDate: '2025-01-01',
        doClasses: ['ScopeDO'],
        bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
        digests: {
          manifest: 'm1',
          permission: 'p1',
          migration: migrations ? await migrationDigestOf({ doClasses: ['ScopeDO'], migrations }) : 'g1',
        },
        registry: { permissions: [], roles: [], entityGrants: [] },
        ...(migrations ? { migrations } : {}),
      }),
    );
    fd.set('tenant', slug);
    fd.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
    return app.request('/verticals/crm/deploy', { method: 'POST', headers: auth, body: fd });
  };
  const extractedOf = (v: { id: string; verticalSlug: string }) => host.admin.versionMigrationsExtracted!(staff, v.verticalSlug, v.id);

  it.each([
    ['registers what the push declares: stored, and its digest recorded', async () => declared, 201, DECLARED_DIGEST],
    ['exposes no registrations (an adapter from before them): stored, never read', async () => null, 201, null],
    ['registers one migration more: refused before upload', async () => [...declared, m('0003-tag', 'ALTER TABLE contacts ADD COLUMN tag TEXT;')], 422, undefined],
    ['registers other SQL under a declared version: refused before upload', async () => [declared[0]!, m('0002-note', 'ALTER TABLE contacts ADD COLUMN body TEXT;')], 422, undefined],
    ['declares other moves for a declared version: refused before upload', async () => [declared[0]!, { ...declared[1]!, moves: { 'contacts.note': 'contacts.body' } }], 422, undefined],
    ['declares other discards for a declared version: refused before upload', async () => [declared[0]!, { ...declared[1]!, discards: { 'contacts.note': 'no longer kept' } }], 422, undefined],
    ['registers the declared migrations in another order: refused before upload', async () => [declared[1]!, declared[0]!], 422, undefined],
    ['cannot be evaluated without its bindings: refused before upload', async () => failed(), 422, undefined],
    ['is read by a loader that failed (the platform’s, not the bundle’s): 503, retryable', async () => {
      throw new MigrationLoaderUnavailable("the platform could not read this bundle's migrations; push again");
    }, 503, undefined],
  ] as const)('a push declaring its migrations whose bundle %s', async (_what, bundle, status, extracted) => {
    registers = bundle;
    deployVertical.mockClear();
    const res = await push(`gate-${ulid().toLowerCase()}`, declared);
    const body = (await res.json()) as { id: string; verticalSlug: string; detail?: string };
    expect(res.status, JSON.stringify(body)).toBe(status);
    if (status !== 201) {
      expect(deployVertical).not.toHaveBeenCalled();
      expect(body.detail).toMatch(
        status === 503
          ? /^the platform could not read this bundle's migrations/
          : /^the (migrations this version's bundle registers are not the ones its push declared \(module acme-crm: |worker entry could not be evaluated)/,
      );
      return;
    }
    expect(await extractedOf(body)).toBe(extracted);
    // The promote review says whether the set it shows was read from the bundle.
    const review = await app.request(`/verticals/${encodeURIComponent(body.verticalSlug)}/versions/${body.id}/migrations`, { headers: auth });
    expect(((await review.json()) as { readFromBundle: boolean }).readFromBundle).toBe(extracted !== null);
  });

  it('a push declaring no migrations ([]) is gated like any other: a bundle registering some is refused', async () => {
    registers = async () => declared;
    deployVertical.mockClear();
    const res = await push(`none-${ulid().toLowerCase()}`, []);
    expect(res.status, await res.clone().text()).toBe(422);
    expect(deployVertical).not.toHaveBeenCalled();
  });

  it.each([
    ['records what the bundle registers, and gates nothing', async () => declared, DECLARED_DIGEST],
    ['is accepted when the bundle cannot be evaluated, never read', async () => failed(), null],
  ] as const)('a push whose manifest leaves its migrations off (over the caps) %s', async (_what, bundle, extracted) => {
    registers = bundle;
    const res = await push(`large-${ulid().toLowerCase()}`, undefined);
    const body = (await res.json()) as { id: string; verticalSlug: string };
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(await extractedOf(body)).toBe(extracted);
    expect(await host.admin.versionMigrations(staff, body.verticalSlug, body.id)).toBeNull();
    // Nothing stored was compared, so the review never says the set it shows was read.
    const review = await app.request(`/verticals/${encodeURIComponent(body.verticalSlug)}/versions/${body.id}/migrations`, { headers: auth });
    expect(((await review.json()) as { readFromBundle: boolean }).readFromBundle).toBe(false);
  });

  it.each([
    ['registers the stored set: read once, recorded, promoted', async () => declared, 200, DECLARED_DIGEST],
    ['registers another set: refused, nothing moves', async () => declared.slice(0, 1), 422, null],
    ['exposes no registrations: promoted as before, never read', async () => null, 200, null],
  ] as const)('the first promote of a version pushed before its bundle was read, whose bundle %s', async (_what, bundle, status, extracted) => {
    registers = async () => null;
    const v = (await (await push(`early-${ulid().toLowerCase()}`, declared)).json()) as { id: string; verticalSlug: string };
    await host.admin.admitVersion(staff, v.id);
    registers = bundle;
    const res = await app.request(`/verticals/${encodeURIComponent(v.verticalSlug)}/channels/prod/promote`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: v.id }),
    });
    expect(res.status, await res.clone().text()).toBe(status);
    expect(await extractedOf(v)).toBe(extracted);
    const channel = (await host.admin.listChannels(staff, v.verticalSlug)).find((ch) => ch.channel === 'prod');
    expect(channel?.versionId ?? null).toBe(status === 200 ? v.id : null);
  });
});

describe('what the loaded worker answers, and the digest recorded (#2351)', () => {
  it('the digest is moved by one SQL byte or one declared move, and not by module order', async () => {
    const other = { ...m('0001-init', 'CREATE TABLE notes (id TEXT);'), moduleId: 'acme-notes' } as DeclaredMigration;
    const base = await extractedMigrationsDigest([...declared, other]);
    expect(await extractedMigrationsDigest([other, ...declared])).toBe(base);
    expect(await extractedMigrationsDigest([{ ...declared[0]!, sql: `${declared[0]!.sql} ` }, declared[1]!, other])).not.toBe(base);
    expect(await extractedMigrationsDigest([{ ...declared[0]!, moves: { 'contacts.id': 'contacts.key' } }, declared[1]!, other])).not.toBe(base);
    expect(await extractedMigrationsDigest([{ ...declared[0]!, discards: { 'contacts.id': 'replaced' } }, declared[1]!, other])).not.toBe(base);
    expect(await extractedMigrationsDigest([declared[1]!, declared[0]!, other])).not.toBe(base);
  });

  it('classes registering one module are one set when they agree, and an error when they do not', () => {
    expect(readExtraction({ classes: [declared, declared] })).toEqual(declared);
    expect(readExtraction({ classes: [] })).toBeNull();
    expect(() => readExtraction({ classes: [declared, declared.slice(0, 1)] })).toThrow(
      'two Durable Object classes register module acme-crm with different migrations',
    );
    expect(() => readExtraction({ classes: [[{ moduleId: 'acme-crm', version: '' }]] })).toThrow(MigrationExtractionError);
  });
});

describe('the Worker Loader extractor, over a fake loader (#2351)', () => {
  const bundle = {
    entry: 'worker.js',
    compatibilityDate: '2025-01-01',
    compatibilityFlags: [],
    modules: [
      { name: 'substrat-platform-entry.js', content: new TextEncoder().encode('export default {}'), contentType: 'application/javascript+module' },
      { name: 'worker.js', content: new TextEncoder().encode('export default {}'), contentType: 'application/javascript+module' },
    ],
  };
  /** A loader whose stub answers `fetch`; records the code it was given. */
  const loaderOf = (fetch: () => Promise<Response>) => {
    const given: Parameters<MigrationLoader['get']>[1][] = [];
    const loader: MigrationLoader = {
      get: (_id, code) => {
        given.push(code);
        return { getEntrypoint: () => ({ fetch }) };
      },
    };
    return { loader, code: () => given[0]!() };
  };

  it('loads the vertical’s own modules with no bindings, no network and a CPU limit', async () => {
    const { loader, code } = loaderOf(async () => Response.json({ classes: [declared] }));
    expect(await loaderMigrationExtractor(loader)(bundle)).toEqual(declared);
    const loaded = code();
    expect(loaded).toMatchObject({ env: {}, globalOutbound: null, limits: { cpuMs: 2000 } });
    expect(Object.keys(loaded.env!)).toEqual([]);
    expect(Object.keys(loaded.modules).sort()).toEqual([loaded.mainModule, 'worker.js'].sort());
  });

  it.each([
    ['does not settle', () => new Promise<Response>(() => {}), MigrationExtractionError, /did not settle within 20 ms$/],
    ['goes over its CPU limit', async () => { throw new Error('Worker exceeded CPU time limit.'); }, MigrationExtractionError, /exceeded CPU/],
    ['carries a module that fails to start', async () => { throw new Error('Failed to start Worker: Uncaught SyntaxError: Unexpected token at other.js:1:13'); }, MigrationExtractionError, /SyntaxError/],
    ['names a compatibility flag the runtime does not know', async () => { throw new Error('No such compatibility flag: not_a_flag'); }, MigrationExtractionError, /No such compatibility flag/],
    ['answers with an error of its own, clipped', async () => Response.json({ error: 'x'.repeat(5000) }), MigrationExtractionError, /x{500}…$/],
    ['meets a loader that failed, whose text stays in the log', async () => { throw new Error('loader reset'); }, MigrationLoaderUnavailable, /^the platform could not read this bundle's migrations; push again$/],
  ] as const)('a read that %s throws whose outcome it is', async (_what, fetch, kind, message) => {
    const read = loaderMigrationExtractor(loaderOf(fetch).loader, { timeoutMs: 20 })(bundle);
    await expect(read).rejects.toBeInstanceOf(kind);
    await expect(read).rejects.toThrow(message);
  });
});
