import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import {
  platformActorId,
  RESERVED_STORE_OPERATIONS,
  scopeId,
  tenantId,
  type ScopeBackup,
  type ScopeDump,
  type StoreKindRegistration,
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
 * (#2243). What decides is the version the scope runs. With no store kind registered no
 * store is asked, and the copies run as they did before stores. With one registered, a
 * version that declares none is not asked either, and a version that cannot be named
 * refuses the copy rather than dropping a store it may hold.
 */
describe('scope-store copies through the platform (#2243, #2207)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const graph: StoreKindRegistration = {
    kind: 'graph',
    release: '0.0.0-test',
    className: 'GraphStore',
    operations: [],
    platformOperations: [...RESERVED_STORE_OPERATIONS],
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

  /** A `docs` scope, bound to a version whose manifest declares `scopeStores` (none when absent). */
  let docsRegistered = false;
  const docsScope = async (bind?: { scopeStores?: unknown[] }) => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
    await host.admin.activateScope(staff, t, s);
    if (bind) {
      if (!docsRegistered) {
        await host.admin.registerVertical(staff, { slug: 'docs', name: 'docs', source: 'cli' });
        docsRegistered = true;
      }
      const id = ulid();
      await host.admin.publishVersion(staff, {
        id,
        verticalSlug: 'docs',
        version: `1.0.${id.slice(-4).toLowerCase()}`,
        manifestDigest: `m-${id}`,
        permissionDigest: 'p',
        migrationDigest: 'g',
        deploymentRef: `docs-${id.toLowerCase()}`,
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

  const appWith = (platformScopeStores: PlatformScopeStores, storeKinds?: readonly StoreKindRegistration[]) =>
    createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      scopeBackups: backups,
      verticals: { docs: deployment },
      platformScopeStores,
      ...(storeKinds ? { storeKinds } : {}),
    });

  /** Each copy the platform takes, through `api`. Every one must succeed with no store. */
  const everyCopy = async (api: ReturnType<typeof createControlPlaneApi>, bind?: { scopeStores?: unknown[] }) => {
    const s = await docsScope(bind);
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

  it('with no store kind registered, no store is asked: the copies run as before stores', async () => {
    const { caller, asked } = platform();
    await everyCopy(appWith(caller));
    expect(asked).toEqual([]);
  });

  it('with a kind registered, a version that declares no store is not asked: every copy proceeds', async () => {
    const { caller, asked } = platform();
    await everyCopy(appWith(caller, [graph]), {});
    expect(asked).toEqual([]);
  });

  it('a version that cannot be named refuses the copy rather than dropping a store it may hold', async () => {
    const { caller, asked } = platform();
    const api = appWith(caller, [graph]);
    const s = await docsScope();
    const backup = await api.request(`/tenants/${t}/scopes/${s}/backups`, { method: 'POST', headers: auth });
    expect(backup.status).toBe(503);
    const pull = await api.request(`/tenants/${t}/scopes/${s}/export?full=true`, { headers: auth });
    expect(pull.status).toBe(503);
    expect(asked).toEqual([]);
  });

  it('a version that declares a store, with no route to the store script, refuses the copy (503)', async () => {
    const { caller, asked } = platform();
    const api = appWith(caller, [graph]);
    const s = await docsScope({ scopeStores: [{ binding: 'GRAPH', kind: 'graph' }] });
    const backup = await api.request(`/tenants/${t}/scopes/${s}/backups`, { method: 'POST', headers: auth });
    expect(backup.status).toBe(503);
    expect(asked).toEqual(['export']);
  });
});
