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
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import {
  createControlPlaneApi,
  DEV_ACTOR_HEADER,
  UNSAFE_devPlatformActorAuth,
  VerticalClient,
  type ScopeBackupStore,
} from '../src/index.js';

/**
 * The platform's copies of a scope (backup, full pull, snapshot, and the reap that backs
 * up first) must not depend on a deployment serving the scope-store routes (#2243 r3). A
 * deployment built before them answers 404, and a deployment whose host lacks the method
 * answers 501: both hold no store, so the copy proceeds without one. With no store kind
 * registered, no deployment is asked at all, which is how these copies ran before stores.
 */
describe('scope-store copies tolerate a deployment without the routes (#2243)', () => {
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

  const docsScope = async () => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
    await host.admin.activateScope(staff, t, s);
    return s;
  };

  /** A deployment that serves everything a copy needs, and answers `status` for the store routes. */
  const deployment = (status: number | 'unasked') => {
    const asked: string[] = [];
    const client = {
      exportScope: async () => [],
      snapshotScope: async () => ({ tables: 0 }),
      deleteScope: async () => undefined,
      scopeStoreExport: async () => {
        asked.push('export');
        if (status === 'unasked') throw new Error('the store export should not be asked');
        throw new ControlPlaneError(status, `answered ${status}`);
      },
      scopeStoreImport: async () => {
        asked.push('import');
        throw new Error('nothing to import');
      },
    };
    return { client: client as unknown as VerticalClient, asked };
  };

  const appWith = (client: VerticalClient, storeKinds?: readonly StoreKindRegistration[]) =>
    createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      scopeBackups: backups,
      verticals: { docs: client },
      ...(storeKinds ? { storeKinds } : {}),
    });

  /** Each copy the platform takes, through `api`. Every one must succeed with no store. */
  const everyCopy = async (api: ReturnType<typeof createControlPlaneApi>) => {
    const s = await docsScope();
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

  it('a deployment built before the routes (404) holds no store: every copy proceeds', async () => {
    const { client, asked } = deployment(404);
    await everyCopy(appWith(client, [graph]));
    expect(asked.filter((a) => a === 'export').length).toBeGreaterThan(0);
    expect(asked).not.toContain('import');
  });

  it('a deployment whose host lacks the method (501) holds no store: every copy proceeds', async () => {
    const { client } = deployment(501);
    await everyCopy(appWith(client, [graph]));
  });

  it('any other answer refuses the copy rather than dropping a store it may hold', async () => {
    const { client } = deployment(503);
    const api = appWith(client, [graph]);
    const s = await docsScope();
    const backup = await api.request(`/tenants/${t}/scopes/${s}/backups`, { method: 'POST', headers: auth });
    expect(backup.status).toBeGreaterThanOrEqual(500);
    const pull = await api.request(`/tenants/${t}/scopes/${s}/export?full=true`, { headers: auth });
    expect(pull.status).toBeGreaterThanOrEqual(500);
  });

  it('with no store kind registered, no deployment is asked: the copies run as before stores', async () => {
    const { client, asked } = deployment('unasked');
    await everyCopy(appWith(client));
    expect(asked).toEqual([]);
  });

  // The producer of the status the copies tolerate: a deployment that does not serve the
  // route answers 404, and the client hands that on as the status, not as an empty list.
  it('the client relays a 404 from the export route as a 404', async () => {
    const client = new VerticalClient({
      fetch: (async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch,
      platformSecret: 'secret',
    });
    const refusal = await client.scopeStoreExport(t, scopeId.parse(ulid())).then(() => undefined, (e: unknown) => e);
    expect(refusal).toBeInstanceOf(ControlPlaneError);
    expect((refusal as ControlPlaneError).status).toBe(404);
  });
});
