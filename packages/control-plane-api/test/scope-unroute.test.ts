import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, webCryptoSecretBox, type HostAdmin } from '@substrat-run/kernel';
import {
  RESERVED_STORE_OPERATIONS,
  platformActorId,
  scopeId,
  tenantId,
  type HostnameBinding,
  type ScopeId,
  type StoreDriverRegistration,
} from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  DEV_ACTOR_HEADER,
  unreachablePlatformScopeStores,
  unrouteScope,
  UNSAFE_devPlatformActorAuth,
  type PlatformScopeStores,
  type VerticalClient,
} from '../src/index.js';

/**
 * A scope stops being routed before its stores are wiped (#2285, L6). The router admits a hostname
 * only while it is active, so the wipe observes the route already gone. A reap that is refused is
 * refused before the unroute: the scope keeps resolving, and its stores are not touched.
 */
describe('a snapshot or a preview is unrouted before its stores are wiped, and only then (#2285)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff };
  const graph: StoreDriverRegistration = {
    kind: 'graph',
    releases: [{ sha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), schema: 0 }],
    className: 'GraphStore',
    operations: [],
    platformOperations: [...RESERVED_STORE_OPERATIONS],
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-unroute-'));
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(6)) });
    await host.admin.createTenant(staff, { id: t, slug: 'unroute-co', name: 'Unroute Co' });
    await host.admin.registerVertical(staff, { slug: 'docs', name: 'docs', source: 'cli', ownerTenant: t });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** An active scope of `docs`, bound to a version that declares one store. */
  const boundSource = async (asPreview?: { tag: string; forkedFrom: ScopeId }) => {
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
    await host.provisionScope(staff, {
      tenantId: t, scopeId: source, vertical: 'docs',
      // What the preview create writes: the slug the preview DELETE route finds it by.
      ...(asPreview ? {
        kind: 'preview', slug: `docs--${asPreview.tag}`,
        forkedFrom: asPreview.forkedFrom, forkedAt: new Date().toISOString(),
      } : {}),
    });
    await host.admin.activateScope(staff, t, source);
    await host.admin.bindScopeVersion(staff, t, source, id);
    return source;
  };

  /** An active hostname on `scope`, which the router resolves. */
  const routed = async (scope: ScopeId) => {
    const hostname = `h-${scope.slice(-8).toLowerCase()}.example`;
    await host.admin.bindHostname(staff, {
      hostname, tenantId: t, scopeId: scope, surface: 'app', region: null, canonical: true,
    });
    await host.admin.setHostnameStatus(staff, hostname, 'active');
    expect((await host.admin.resolveHostname(hostname))?.scopeId).toBe(scope);
    return hostname;
  };

  /** A snapshot fork of a bound source, routed. */
  const snapshot = async (bound = true) => {
    const source = bound ? await boundSource() : scopeId.parse(ulid());
    if (!bound) {
      await host.provisionScope(staff, { tenantId: t, scopeId: source, vertical: 'docs' });
      await host.admin.activateScope(staff, t, source);
    }
    const id = await host.snapshotScope(staff, t, source);
    return { id, hostname: await routed(id) };
  };

  /** A preview of `docs` under `tag`, forked from a bound source, routed. */
  const preview = async (tag: string) => {
    const id = await boundSource({ tag, forkedFrom: await boundSource() });
    return { id, hostname: await routed(id) };
  };

  /** The store caller: records whether the scope's hostname still resolved when `wipe` ran. */
  const witness = (hostname: () => string) => {
    const seen: string[] = [];
    const caller: PlatformScopeStores = {
      ...unreachablePlatformScopeStores(),
      wipeStores: async () => {
        seen.push((await host.admin.resolveHostname(hostname()))?.scopeId ?? 'unrouted');
      },
    };
    return { caller, seen };
  };

  const apiWith = (caller: PlatformScopeStores, dispatch: boolean) =>
    createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      storeDrivers: [graph],
      platformScopeStores: caller,
      ...(dispatch ? { resolveVerticalRef: async () => undefined } : {}),
    });

  /** A copy move in flight on `scope`: a reap claim refuses it (412). */
  const moveInFlight = async (scope: ScopeId) => {
    await host.admin.recordScopeScriptCopy(staff, t, scope, `docs-copy-${scope.toLowerCase()}`, ulid(), { role: 'destination' });
  };

  describe('the snapshot DELETE', () => {
    it('the wipe sees no route, and the hostname resolved until the delete', async () => {
      const fork = await snapshot();
      const { caller, seen } = witness(() => fork.hostname);
      const res = await apiWith(caller, false).request(`/tenants/${t}/scopes/${fork.id}`, { method: 'DELETE', headers: auth });
      expect(res.status).toBe(200);
      expect(seen).toEqual(['unrouted']);
      expect(await host.admin.resolveHostname(fork.hostname)).toBeUndefined();
    });

    it('a reap refused by a copy move in flight keeps the hostname, and wipes nothing', async () => {
      const fork = await snapshot();
      await moveInFlight(fork.id);
      const { caller, seen } = witness(() => fork.hostname);
      const res = await apiWith(caller, true).request(`/tenants/${t}/scopes/${fork.id}`, { method: 'DELETE', headers: auth });
      expect(res.status).toBe(412);
      expect(seen).toEqual([]);
      expect((await host.admin.resolveHostname(fork.hostname))?.scopeId).toBe(fork.id);
    });

    it('a reap refused because its stores cannot be named keeps the hostname', async () => {
      // A kind is registered, and a fork of an unbound, unpinned source runs a version nobody can name.
      const fork = await snapshot(false);
      const { caller, seen } = witness(() => fork.hostname);
      const res = await apiWith(caller, false).request(`/tenants/${t}/scopes/${fork.id}`, { method: 'DELETE', headers: auth });
      expect(res.status).toBe(503);
      expect(seen).toEqual([]);
      expect((await host.admin.resolveHostname(fork.hostname))?.scopeId).toBe(fork.id);
    });
  });

  it('a name rebound to another scope between the list and the unbind stays with that scope', async () => {
    // The sweep and a preview re-push can reap one stale preview at once: the re-push binds the
    // same `--tag` name to its new fork while the sweep's unroute still holds the old list.
    const old = await snapshot();
    const keep = `keep-${old.id.slice(-8).toLowerCase()}.example`;
    await host.admin.bindHostname(staff, { hostname: keep, tenantId: t, scopeId: old.id, surface: 'app', region: null, canonical: false });
    const fresh = await snapshot();
    let moved = false;
    const interleaved: Pick<HostAdmin, 'listHostnames' | 'unbindHostname'> = {
      listHostnames: (actor, filter) => host.admin.listHostnames(actor, filter),
      unbindHostname: async (actor, hostname, owner) => {
        if (!moved && hostname === old.hostname) {
          moved = true;
          await host.admin.unbindHostname(staff, old.hostname);
          await host.admin.bindHostname(staff, {
            hostname: old.hostname, tenantId: t, scopeId: fresh.id, surface: 'app', region: null, canonical: false,
          });
        }
        return host.admin.unbindHostname(actor, hostname, owner);
      },
    };
    await unrouteScope(interleaved, staff, { tenantId: t, id: old.id });
    expect(moved).toBe(true);
    const names = async (s: ScopeId) => (await host.admin.listHostnames(staff, { scopeId: s })).map((h) => h.hostname);
    expect(await names(fresh.id)).toContain(old.hostname);
    // The twin: every name still on the scope being unrouted goes.
    expect(await names(old.id)).toEqual([]);
  });

  describe('the preview DELETE', () => {
    it('the wipe sees no route, and the hostname resolved until the reap', async () => {
      const pr = await preview('pr-1');
      const { caller, seen } = witness(() => pr.hostname);
      const res = await apiWith(caller, false).request('/verticals/docs/previews/pr-1', { method: 'DELETE', headers: auth });
      expect(res.status).toBe(200);
      expect(seen).toEqual(['unrouted']);
      expect(await host.admin.resolveHostname(pr.hostname)).toBeUndefined();
    });

    it('an unroute that fails keeps the preview signing in: its clients are retired only after (#1704)', async () => {
      // Its own tenant and vertical, with an auth server the preview's clients live at.
      const t2 = tenantId.parse(ulid());
      const slug = `desk-${t2.slice(-6).toLowerCase()}`;
      await host.admin.createTenant(staff, { id: t2, slug, name: 'Desk Co' });
      await host.admin.registerVertical(staff, { slug, name: slug, source: 'cli', ownerTenant: t2 });
      if (!(await host.admin.listVerticals(staff)).some((v) => v.slug === 'auth-server')) {
        await host.admin.registerVertical(staff, { slug: 'auth-server', name: 'Auth', source: 'builtin', ownerTenant: null, provides: ['oidc-issuer'] });
      }
      const issuer = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t2, scopeId: issuer, vertical: 'auth-server' });
      await host.admin.activateScope(staff, t2, issuer);
      const prod = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t2, scopeId: prod, vertical: slug });
      await host.admin.activateScope(staff, t2, prod);
      const pr = scopeId.parse(ulid());
      await host.provisionScope(staff, {
        tenantId: t2, scopeId: pr, vertical: slug, kind: 'preview', slug: `${slug}--pr-9`,
        forkedFrom: prod, forkedAt: new Date().toISOString(),
      });
      await host.admin.activateScope(staff, t2, pr);
      const hostname = `h-${pr.slice(-8).toLowerCase()}.example`;
      await host.admin.bindHostname(staff, { hostname, tenantId: t2, scopeId: pr, surface: 'app', region: null, canonical: true });
      await host.admin.setHostnameStatus(staff, hostname, 'active');
      const retired: string[] = [];
      const issuerClient = {
        retirePreviewClients: async ({ previewScopeId }: { previewScopeId: string }) => {
          retired.push(previewScopeId);
          return { deleted: [] };
        },
      } as unknown as VerticalClient;
      const api = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        verticals: { 'auth-server': issuerClient },
      });
      const unbind = host.admin.unbindHostname;
      host.admin.unbindHostname = async () => {
        throw new Error('unbind failed');
      };
      try {
        const res = await api.request(`/verticals/${slug}/previews/pr-9`, { method: 'DELETE', headers: auth });
        expect(res.status).toBe(500);
      } finally {
        host.admin.unbindHostname = unbind;
      }
      expect(retired).toEqual([]);
      expect((await host.admin.resolveHostname(hostname))?.scopeId).toBe(pr);
      // The twin: once the unroute succeeds, the clients go, and so does the preview.
      const res = await api.request(`/verticals/${slug}/previews/pr-9`, { method: 'DELETE', headers: auth });
      expect(res.status).toBe(200);
      expect(retired).toEqual([pr]);
      expect(await host.admin.resolveHostname(hostname)).toBeUndefined();
    });

    it('a reap refused by a copy move in flight keeps the preview routed, and wipes nothing', async () => {
      const pr = await preview('pr-2');
      await moveInFlight(pr.id);
      const { caller, seen } = witness(() => pr.hostname);
      const res = await apiWith(caller, true).request('/verticals/docs/previews/pr-2', { method: 'DELETE', headers: auth });
      expect(res.status).toBe(412);
      expect(seen).toEqual([]);
      expect((await host.admin.resolveHostname(pr.hostname))?.scopeId).toBe(pr.id);
    });
  });
});

describe('unrouteScope unbinds every hostname, page after page (#2285)', () => {
  const actor = platformActorId.parse(ulid());
  const scope = { tenantId: tenantId.parse(ulid()), id: scopeId.parse(ulid()) };

  /** A directory that hands out two hostnames a page, whatever the limit asked. */
  const paged = (names: string[], keep = new Set<string>()) => {
    const bound = new Set(names);
    const admin: Pick<HostAdmin, 'listHostnames' | 'unbindHostname'> = {
      listHostnames: async () => [...bound].slice(0, 2).map((hostname) => ({ hostname }) as HostnameBinding),
      unbindHostname: async (_actor, hostname) => {
        if (!keep.has(hostname)) bound.delete(hostname);
      },
    };
    return { admin, bound };
  };

  it('five hostnames over three pages are all unbound', async () => {
    const { admin, bound } = paged(['a', 'b', 'c', 'd', 'e']);
    await unrouteScope(admin, actor, scope);
    expect([...bound]).toEqual([]);
  });

  it('a hostname still listed after its unbind refuses rather than loop', async () => {
    const { admin } = paged(['a', 'b'], new Set(['b']));
    await expect(unrouteScope(admin, actor, scope)).rejects.toThrow(/still bound/);
  });
});
