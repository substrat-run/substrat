import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import {
  RESERVED_STORE_OPERATIONS,
  platformActorId,
  scopeId,
  tenantId,
  type StoreKindRegistration,
} from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  DEV_ACTOR_HEADER,
  unreachablePlatformScopeStores,
  UNSAFE_devPlatformActorAuth,
  type PlatformScopeStores,
} from '../src/index.js';

/**
 * A scope stops being routed before its stores are wiped (#2285). The router admits a hostname
 * only while it is active, so the wipe observes the route already gone. The twin is the same
 * hostname resolving before the delete.
 */
describe('a snapshot is unrouted before its stores are wiped (#2285)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff };
  const graph: StoreKindRegistration = {
    kind: 'graph',
    runtime: 'python',
    className: 'GraphStore',
    operations: [],
    platformOperations: [...RESERVED_STORE_OPERATIONS],
    publishers: 'staff',
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-unroute-'));
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(6)) });
    await host.admin.createTenant(staff, { id: t, slug: 'unroute-co', name: 'Unroute Co' });
    await host.admin.registerVertical(staff, { slug: 'docs', name: 'docs', source: 'cli' });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the wipe sees no route, and the hostname resolved until the delete', async () => {
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
        scopeStores: [{ binding: 'GRAPH', kind: 'graph' }],
      }),
    });
    await host.admin.admitVersion(staff, id);
    const source = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: source, vertical: 'docs' });
    await host.admin.activateScope(staff, t, source);
    await host.admin.bindScopeVersion(staff, t, source, id);
    const snapshot = await host.snapshotScope(staff, t, source);
    const hostname = `fork-${snapshot.slice(-6).toLowerCase()}.example`;
    await host.admin.bindHostname(staff, {
      hostname, tenantId: t, scopeId: snapshot, surface: 'app', region: null, canonical: true,
    });
    await host.admin.setHostnameStatus(staff, hostname, 'active');
    expect((await host.admin.resolveHostname(hostname))?.scopeId).toBe(snapshot);

    const seen: string[] = [];
    const caller: PlatformScopeStores = {
      ...unreachablePlatformScopeStores(),
      wipeStores: async () => {
        seen.push((await host.admin.resolveHostname(hostname))?.scopeId ?? 'unrouted');
      },
    };
    const api = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      storeKinds: [graph],
      platformScopeStores: caller,
    });
    const res = await api.request(`/tenants/${t}/scopes/${snapshot}`, { method: 'DELETE', headers: auth });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['unrouted']);
    expect(await host.admin.resolveHostname(hostname)).toBeUndefined();
  });
});
