import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import {
  platformActorId,
  scopeId,
  tenantId,
  type ScopeBackup,
  type ScopeDump,
  type StoreDriverRegistration,
} from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  DEV_ACTOR_HEADER,
  unreachablePlatformScopeStores,
  UNSAFE_devPlatformActorAuth,
  type PlatformScopeStores,
  type ScopeBackupStore,
  type VerticalClient,
} from '../src/index.js';

/**
 * The platform's copies of a scope (backup, full pull, snapshot, and the reap that wipes
 * first) reach its stores through the platform (#2207), never through the vertical: a
 * deployment built before stores, or one that serves no store route, changes nothing
 * (#2243). What decides is the version the scope runs. With no store driver registered no
 * store is asked, and the copies run as they did before stores. With one registered, a
 * version that declares none is not asked either, and a version that cannot be named
 * refuses the copy rather than dropping a store it may hold — where a version of the
 * scope's vertical declared one, since no store can exist under a binding none declared
 * (#2394).
 */
describe('scope-store copies through the platform (#2243, #2207)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const graph: StoreDriverRegistration = {
    driver: 'graph',
    isolationBasis: { kind: 'writtenInRepo' },
  };

  const held = new Map<string, ScopeDump>();
  const backups: ScopeBackupStore = {
    put: async ({ dump }) => {
      held.set(dump.capturedAt, dump);
      return {
        tenantId: dump.tenantId,
        scopeId: dump.scopeId,
        vertical: null,
        capturedAt: dump.capturedAt,
        size: 1,
        tables: dump.tables.length,
      } satisfies ScopeBackup;
    },
    list: async () => [],
    get: async ({ capturedAt }) => held.get(capturedAt) ?? null,
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-store-copies-'));
    host = new SqliteScopeHost({ dir });
    await host.admin.createTenant(staff, { id: t, slug: 'copies-co', name: 'Copies Co' });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A scope of `vertical` (`docs` unless named), bound to a version whose manifest declares
   * `scopeStores` (none when absent). Each vertical is its own: the lifecycle reaches every binding
   * any version of a vertical declared (#2286), so one that declares a store reaches it after.
   */
  const registered = new Set<string>();
  const docsScope = async (bind?: { scopeStores?: unknown[] }, vertical = 'docs') => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical });
    await host.admin.activateScope(staff, t, s);
    if (bind) {
      if (!registered.has(vertical)) {
        await host.admin.registerVertical(staff, { slug: vertical, name: vertical, source: 'cli' });
        registered.add(vertical);
      }
      const id = ulid();
      await host.admin.publishVersion(staff, {
        id,
        verticalSlug: vertical,
        version: `1.0.${id.toLowerCase()}`,
        manifestDigest: `m-${id}`,
        permissionDigest: 'p',
        migrationDigest: 'g',
        deploymentRef: `${vertical}-${id.toLowerCase()}`,
        manifestJson: JSON.stringify({
          version: '1.0.0',
          entry: 'index.js',
          compatibilityDate: '2026-07-01',
          registry: { permissions: [], roles: [], entityGrants: [] },
          digests: { manifest: 'm', permission: 'p', migration: 'g' },
          ...(bind.scopeStores ? { scopeStores: bind.scopeStores } : {}),
        }),
      });
      await host.admin.admitVersion(staff, id);
      await host.admin.bindScopeVersion(staff, t, s, id);
    }
    return s;
  };

  /** A deployment with no store route at all, and a platform caller that records what is asked. */
  const deployment = {
    exportScope: async () => [],
    snapshotScope: async () => ({ tables: 0 }),
    deleteScope: async () => undefined,
  } as unknown as VerticalClient;
  const platform = () => {
    const asked: string[] = [];
    const refuse = unreachablePlatformScopeStores();
    const caller: PlatformScopeStores = {
      exportStores: async (input) => (asked.push('export'), refuse.exportStores(input)),
      importStores: async (input) => (asked.push('import'), refuse.importStores(input)),
      eraseSubject: async (input) => (asked.push('erase'), refuse.eraseSubject(input)),
      wipeStores: async (input) => (asked.push('wipe'), refuse.wipeStores(input)),
      sizeStores: async (input) => (asked.push('size'), refuse.sizeStores(input)),
    };
    return { caller, asked };
  };

  const appWith = (platformScopeStores: PlatformScopeStores, storeDrivers?: readonly StoreDriverRegistration[]) =>
    createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      scopeBackups: backups,
      // `notes` never declares a store in this file, and `files` always has one version that does.
      verticals: { docs: deployment, notes: deployment, files: deployment },
      platformScopeStores,
      ...(storeDrivers ? { storeDrivers } : {}),
    });

  /** Each copy the platform takes, through `api`. Every one must succeed with no store. */
  const everyCopy = async (api: ReturnType<typeof createControlPlaneApi>, bind?: { scopeStores?: unknown[] }, vertical?: string) => {
    const s = await docsScope(bind, vertical);
    const backup = await api.request(`/tenants/${t}/scopes/${s}/backups`, { method: 'POST', headers: auth });
    expect(backup.status).toBe(201);
    expect([...held.values()].at(-1)?.stores).toEqual([]);
    const pull = await api.request(`/tenants/${t}/scopes/${s}/export?full=true`, { headers: auth });
    expect(pull.status).toBe(200);
    expect(((await pull.json()) as { stores: unknown[] }).stores).toEqual([]);
    const snap = await api.request(`/tenants/${t}/scopes/${s}/snapshots`, { method: 'POST', headers: auth, body: '{}' });
    expect(snap.status).toBe(201);
    await host.admin.archiveScope(staff, t, s);
    const reap = await api.request(`/tenants/${t}/scopes/${s}/reap`, { method: 'POST', headers: auth, body: '{}' });
    expect(reap.status).toBe(200);
    expect(((await reap.json()) as { status: string }).status).toBe('reaped');
  };

  it('with no store driver registered, no store is asked: the copies run as before stores', async () => {
    const { caller, asked } = platform();
    await everyCopy(appWith(caller, []));
    expect(asked).toEqual([]);
  });

  it('with a driver registered, a version that declares no store is not asked: every copy proceeds', async () => {
    const { caller, asked } = platform();
    await everyCopy(appWith(caller, [graph]), {});
    expect(asked).toEqual([]);
  });

  /** A `files` scope whose version cannot be named, beside a version of `files` that declares GRAPH. */
  const unnamedBesideAStore = async () => {
    await docsScope({ scopeStores: [{ binding: 'GRAPH', driver: 'graph' }] }, 'files');
    return docsScope(undefined, 'files');
  };

  // A version that cannot be named, judged against an injected registry and the hosted default, which holds graph.
  for (const [registry, drivers] of [['an injected', [graph]], ['the default', undefined]] as const) {
    it(`with ${registry} registry, a version that cannot be named refuses the copy where a version of its vertical declared a store`, async () => {
      const { caller, asked } = platform();
      const api = appWith(caller, drivers);
      const s = await unnamedBesideAStore();
      const backup = await api.request(`/tenants/${t}/scopes/${s}/backups`, { method: 'POST', headers: auth });
      expect(backup.status).toBe(503);
      const pull = await api.request(`/tenants/${t}/scopes/${s}/export?full=true`, { headers: auth });
      expect(pull.status).toBe(503);
      expect(asked).toEqual([]);
    });

    // #2394: no version of `notes` declared a store, so no object of it can exist to be dropped.
    it(`with ${registry} registry, a version that cannot be named in a vertical that never declared a store is not asked: every copy proceeds`, async () => {
      const { caller, asked } = platform();
      await everyCopy(appWith(caller, drivers), undefined, 'notes');
      expect(asked).toEqual([]);
    });
  }

  it('with no store driver registered, a version that cannot be named beside a declared store is not asked: every copy proceeds', async () => {
    const { caller, asked } = platform();
    await unnamedBesideAStore();
    await everyCopy(appWith(caller, []), undefined, 'files');
    expect(asked).toEqual([]);
  });

  for (const [registry, drivers] of [['an injected', [graph]], ['the default', undefined]] as const) {
    it(`with ${registry} registry, a version that declares a store, with no route to the store script, refuses the copy (503)`, async () => {
      const { caller, asked } = platform();
      const api = appWith(caller, drivers);
      const s = await docsScope({ scopeStores: [{ binding: 'GRAPH', driver: 'graph' }] });
      const backup = await api.request(`/tenants/${t}/scopes/${s}/backups`, { method: 'POST', headers: auth });
      expect(backup.status).toBe(503);
      expect(asked).toEqual(['export']);
    });
  }

  // The registry a hosted control plane runs: no `storeDrivers`, so `STORE_DRIVERS`, which holds graph.
  it('with the default registry, a version that declares no store is not asked: every copy proceeds', async () => {
    const { caller, asked } = platform();
    await everyCopy(appWith(caller), {}, 'notes');
    expect(asked).toEqual([]);
  });
});
