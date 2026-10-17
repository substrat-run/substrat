import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId, type ScopeDumpTable, type ScopeId, type TenantId } from '@substrat-run/contracts';
import type { VerticalClient } from '../src/vertical-client.js';
import {
  createControlPlaneApi,
  tenantTokenAuth,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth,
} from '../src/index.js';

/**
 * #2347: who may read a rebind review. Exactly who may make the rebind it answers: a confined
 * credential must be able to read both verticals, its own tenant's or a listed one, by the one rule
 * the rebind and the read share. And a refusal must not tell such a caller whether another tenant's
 * vertical exists, or what it serves: every way of not being allowed answers the same bytes.
 */
describe('the rebind review read (#2347)', () => {
  const SECRET = 'test-tenant-token-secret';
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const staff = platformActorId.parse(ulid());
  const staffHeaders = { [DEV_ACTOR_HEADER]: staff };
  const tA = tenantId.parse(ulid());
  const tB = tenantId.parse(ulid());
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  let asA: Record<string, string>;
  /** A's install of its own vertical, of a listed one it does not own, of B's private one, and B's install. */
  let own: ScopeId;
  let onListed: ScopeId;
  let onForeign: ScopeId;
  let theirs: ScopeId;
  let install: (t: TenantId, slug: string) => Promise<ScopeId>;

  // Data belongs to the script it was written under, as a Durable Object namespace does.
  const scripts = new Map<string, Map<string, ScopeDumpTable[]>>();
  const ensure = (ref: string) => scripts.get(ref) ?? (scripts.set(ref, new Map()), scripts.get(ref)!);
  const clientFor = (ref: string) =>
    ({
      exportScopeStamped: async (sc: string) => ({ tables: ensure(ref).get(sc) ?? [], loadStamp: null, revision: null }),
      restoreScope: async (_t: string, sc: string, tables: ScopeDumpTable[]) => {
        ensure(ref).set(sc, tables);
        return { tables: tables.length };
      },
    }) as unknown as VerticalClient;

  const read = (t: TenantId, sc: string, target: string, headers: Record<string, string>) =>
    app.request(`/tenants/${t}/scopes/${sc}/rebind-review?vertical=${encodeURIComponent(target)}`, { headers });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-rebind-review-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(SECRET, serviceActor),
      tenantTokenSecret: SECRET,
      resolveVerticalRef: async (ref) => clientFor(ref),
      resolveVerticalVersion: async (slug, versionId) => clientFor(`${slug.replace('/', '-')}-${versionId.toLowerCase()}`),
    });
    await host.admin.createTenant(staff, { id: tA, slug: 'acme', name: 'Acme' });
    await host.admin.createTenant(staff, { id: tB, slug: 'rival', name: 'Rival' });
    const version = async (slug: string, serve: boolean) => {
      const id = ulid();
      await host.admin.publishVersion(staff, {
        id, verticalSlug: slug, version: '1.0.0', manifestDigest: 'm', permissionDigest: 'p', migrationDigest: `g-${slug}`, deploymentRef: `${slug.replace('/', '-')}-${id.toLowerCase()}`,
      });
      await host.admin.admitVersion(staff, id);
      if (serve) await host.admin.setVerticalServing(staff, slug, { ref: `serving-${slug.replace('/', '-')}`, versionId: id, doClasses: [], migrationTag: 't' });
      return id;
    };
    const verticals: [string, TenantId | null, boolean][] = [
      ['acme/app', tA, false], ['acme/next', tA, true], ['acme/idle', tA, false], ['rival/app', tB, true], ['rival/idle', tB, false], ['shared/app', null, true],
    ];
    const ids: Record<string, string> = {};
    for (const [slug, owner, serve] of verticals) {
      await host.admin.registerVertical(staff, { slug, name: slug, source: 'cli', ...(owner ? { ownerTenant: owner } : {}) });
      ids[slug] = await version(slug, serve);
    }
    await host.admin.setVerticalListed(staff, 'shared/app', true);
    install = async (t: TenantId, slug: string) => {
      const sc = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: sc, vertical: slug });
      await host.admin.activateScope(staff, t, sc);
      await host.admin.bindScopeVersion(staff, t, sc, ids[slug]!);
      return sc;
    };
    own = await install(tA, 'acme/app');
    onListed = await install(tA, 'shared/app');
    onForeign = await install(tA, 'rival/idle');
    theirs = await install(tB, 'rival/app');
    const res = await app.request('/tenant-tokens', {
      method: 'POST', headers: { ...staffHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ tenantId: tA }),
    });
    asA = { [SERVICE_TOKEN_HEADER]: ((await res.json()) as { token: string }).token };
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A response as a caller sees it: status, every header, and the body bytes. */
  const seen = async (res: Response) => ({ status: res.status, headers: [...res.headers.entries()], body: await res.text() });

  it('answers a confined caller the same bytes for every lineage it may not read, whether it exists or not', async () => {
    const refusals = await Promise.all([
      read(tA, own, 'rival/app', asA), // another tenant's vertical, serving
      read(tA, own, 'rival/idle', asA), // another tenant's vertical, serving nothing
      read(tA, own, 'nobody/none', asA), // no such vertical
      read(tA, onForeign, 'acme/next', asA), // the scope runs a vertical the caller cannot read
      read(tA, ulid(), 'acme/next', asA), // no such scope
    ].map(async (p) => seen(await p)));
    expect(refusals[0]!.status).toBe(404);
    for (const r of refusals.slice(1)) expect(r).toEqual(refusals[0]);
    expect(refusals[0]!.body).not.toMatch(/rival|nobody|shared|serv/);
    // The rebind refuses the same crossings with the same bytes: one rule decides both.
    const rebind = (sc: string, target: string) =>
      app.request(`/tenants/${tA}/scopes/${sc}/rebind-vertical`, {
        method: 'POST', headers: { ...asA, 'content-type': 'application/json' }, body: JSON.stringify({ vertical: target }),
      });
    for (const [sc, target] of [[own, 'rival/app'], [own, 'nobody/none'], [onForeign, 'acme/next'], [ulid(), 'acme/next']] as const) {
      expect(await seen(await rebind(sc, target))).toEqual(refusals[0]);
    }
  });

  it('reads and rebinds onto a LISTED vertical it does not own, and off one, as the rebind allows', async () => {
    // Onto: an install of the tenant's own vertical, moving onto a listed one.
    const mover = await install(tA, 'acme/app');
    const onto = await read(tA, mover, 'shared/app', asA);
    expect(onto.status, await onto.clone().text()).toBe(200);
    const shown = (await onto.json()) as { digestsMatch: boolean; review: { base: string; digest: string } };
    expect(shown.digestsMatch).toBe(false);
    // Off: an install of the listed vertical, moving onto the tenant's own.
    expect((await read(tA, onListed, 'acme/next', asA)).status).toBe(200);
    // The rebind bound to that review lands, by a tenant credential with no staff in sight.
    const res = await app.request(`/tenants/${tA}/scopes/${mover}/rebind-vertical`, {
      method: 'POST',
      headers: { ...asA, 'content-type': 'application/json' },
      body: JSON.stringify({ vertical: 'shared/app', ackMigrations: true, acknowledge: { review: shown.review } }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const rec = await host.admin.getScopeRecord(staff, tA, mover);
    expect([rec?.vertical, rec?.servingRef]).toEqual(['shared/app', 'serving-shared-app']);
  });

  it('reads both sides it owns, with the binding — the positive twin', async () => {
    const res = await read(tA, own, 'acme/next', asA);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { base: { vertical: string }; target: { vertical: string }; review: { base: string; digest: string } };
    expect([body.base.vertical, body.target.vertical]).toEqual(['acme/app', 'acme/next']);
    expect(body.review.digest).toMatch(/^[0-9a-f]{64}$/);
    // Only once both sides are its own does it learn that a target serves nothing.
    expect((await read(tA, own, 'acme/idle', asA)).status).toBe(409);
  });

  it("refuses another tenant's scope at the path pin, and staff read across tenants", async () => {
    expect((await read(tB, theirs, 'rival/app', asA)).status).toBe(403);
    expect((await read(tB, theirs, 'acme/next', staffHeaders)).status).toBe(200);
    expect((await read(tA, onForeign, 'acme/next', staffHeaders)).status).toBe(200);
  });
});
