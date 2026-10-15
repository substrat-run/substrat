import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { unreachablePlatformScopeStores, type PlatformScopeStores } from '@substrat-run/control-plane-api';
import { RESERVED_STORE_OPERATIONS, platformActorId, scopeId, tenantId, type StoreKindRegistration } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { reapExpiredSnapshot } from '../src/worker.js';

/**
 * The sweep's reap of an expired snapshot (#2285): it unroutes the fork before it wipes the fork's
 * stores, and a reap it cannot finish is refused before the unroute, so the fork stays routed.
 */
describe('the sweep unroutes an expired snapshot before its wipe, and only then (#2285)', () => {
  const staff = platformActorId.parse(ulid());
  const graph: StoreKindRegistration = {
    kind: 'graph',
    release: '0.0.0-test',
    className: 'GraphStore',
    operations: [],
    platformOperations: [...RESERVED_STORE_OPERATIONS],
  };

  /** A routed fork of a source bound to a version that declares one store. */
  const routedFork = async (host: CloudflareScopeHost) => {
    const t = tenantId.parse(ulid());
    const slug = `sweep-${t.slice(-8).toLowerCase()}`;
    await host.admin.createTenant(staff, { id: t, slug, name: 'Sweep Co' });
    await host.admin.registerVertical(staff, { slug, name: slug, source: 'cli' });
    const version = ulid();
    await host.admin.publishVersion(staff, {
      id: version,
      verticalSlug: slug,
      version: '1.0.0',
      manifestDigest: `m-${version}`,
      permissionDigest: 'p',
      migrationDigest: 'g',
      deploymentRef: `${slug}-v1`,
      manifestJson: JSON.stringify({
        version: '1.0.0', entry: 'index.js', compatibilityDate: '2026-07-01',
        registry: { permissions: [], roles: [], entityGrants: [] },
        digests: { manifest: 'm', permission: 'p', migration: 'g' },
        scopeStores: [{ binding: 'GRAPH', kind: 'graph' }],
      }),
    });
    await host.admin.admitVersion(staff, version);
    const source = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: source, vertical: slug });
    const fork = scopeId.parse(ulid());
    await host.provisionScope(staff, {
      tenantId: t, scopeId: fork, vertical: slug, forkedFrom: source, forkedAt: new Date().toISOString(),
    });
    await host.admin.activateScope(staff, t, fork);
    await host.admin.bindScopeVersion(staff, t, fork, version);
    const hostname = `fork-${fork.slice(-8).toLowerCase()}.example`;
    await host.admin.bindHostname(staff, { hostname, tenantId: t, scopeId: fork, surface: 'app', region: null, canonical: true });
    await host.admin.setHostnameStatus(staff, hostname, 'active');
    expect((await host.admin.resolveHostname(hostname))?.scopeId).toBe(fork);
    return { t, fork, hostname };
  };

  /** The store caller: records whether the fork's hostname still resolved when `wipe` ran. */
  const witness = (host: CloudflareScopeHost, hostname: () => string) => {
    const seen: string[] = [];
    const stores: PlatformScopeStores = {
      ...unreachablePlatformScopeStores(),
      wipeStores: async () => {
        seen.push((await host.admin.resolveHostname(hostname()))?.scopeId ?? 'unrouted');
      },
    };
    return { stores, seen };
  };

  it('the wipe sees no route, and the fork is gone after', async () => {
    const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
    const { t, fork, hostname } = await routedFork(host);
    const { stores, seen } = witness(host, () => hostname);
    await reapExpiredSnapshot({ host, stores, issuerClient: async () => undefined, kinds: [graph] }, t, fork);
    expect(seen).toEqual(['unrouted']);
    expect(await host.admin.resolveHostname(hostname)).toBeUndefined();
    expect(await host.admin.getScopeRecord(staff, t, fork)).toBeUndefined();
  });

  it('a reap refused by a copy move in flight keeps the fork routed, and wipes nothing', async () => {
    const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
    const { t, fork, hostname } = await routedFork(host);
    await host.admin.recordScopeScriptCopy(staff, t, fork, `copy-${fork.toLowerCase()}`, ulid(), { role: 'destination' });
    const { stores, seen } = witness(host, () => hostname);
    const refused = await reapExpiredSnapshot({
      host, stores, issuerClient: async () => undefined, kinds: [graph], resolveRef: async () => undefined,
    }, t, fork).then(() => undefined, (e: unknown) => e as { status?: number });
    expect(refused?.status).toBe(412);
    expect(seen).toEqual([]);
    expect((await host.admin.resolveHostname(hostname))?.scopeId).toBe(fork);
  });
});
