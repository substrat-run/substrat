import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import {
  assertAllowed,
  capabilityTokenHash,
  ulid,
  type ModuleRegistration,
  type OperationHandler,
  undeclaredOperations
} from '@substrat-run/kernel';
import {
  capabilityRecord,
  moduleId,
  moduleManifest,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type CapabilityFilter,
  type CapabilityPage,
  type Instant,
  type MintedCapability,
} from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  firstBuilderAuth,
  mintPushToken,
  pushActorFor,
  pushTokenBuilderAuth,
  tenantTokenAuth,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth,
  ControlPlaneError,
  type VerticalClient,
} from '../src/index.js';

/**
 * The operator's capability read over HTTP (#1686): `GET …/scopes/:s/capabilities`.
 *
 * Two claims, each shown with its positive twin on the SAME route and scope:
 *
 *  - **Staff only.** A tenant credential and a builder — the two other principals the control
 *    plane authenticates — are refused 403, and staff reads the very rows they were refused.
 *    A refusal that only held because the route happened to be unreachable would pass a
 *    status check and fail the twin.
 *  - **Never a secret or a hash**, whichever branch served the read.
 */
const SHARE = moduleId.parse('@test/share');
const READ = permissionKey.parse('doc:read');

const shareModule: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: SHARE,
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [{ key: 'doc:read', description: 'read a document' }],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'share',
  }),
  migrations: [{ version: '0001-init', sql: 'CREATE TABLE shares (id TEXT PRIMARY KEY)' }],
  ...undeclaredOperations('a test fixture, built to drive the host rather than declared', {
    'doc/share': (async (ctx, input) => {
      assertAllowed(await ctx.check(READ));
      return ctx.capabilities.mint(input as Parameters<typeof ctx.capabilities.mint>[0]);
    }) as OperationHandler<never, unknown>,
    'doc/unshare': (async (ctx, input) => {
      assertAllowed(await ctx.check(READ));
      await ctx.capabilities.revoke((input as { id: never }).id);
    }) as OperationHandler<never, unknown>,
  }),
};

const HEX64 = /\b[0-9a-f]{64}\b/i;

describe('GET /tenants/:t/scopes/:s/capabilities (#1686)', () => {
  const TENANT_SECRET = 'test-tenant-token-secret';
  const PUSH_SECRET = 'test-push-token-secret';
  const t = tenantId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const serviceActor = platformActorId.parse('01JZ00000000000000000000CP');
  const owner = principalId.parse(ulid());
  const seat = principalId.parse(ulid());
  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  let asTenant: Record<string, string>;
  let asBuilder: Record<string, string>;
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  let s: string;
  let link: MintedCapability;
  let gone: MintedCapability;
  let claim: MintedCapability;
  const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString() as Instant;

  const route = (scope: string = s, tenant: string = t, query = '') =>
    `/tenants/${tenant}/scopes/${scope}/capabilities${query}`;
  const get = (path: string, headers: Record<string, string>, a = app) => a.request(path, { method: 'GET', headers });
  const page = async (res: Response) => (await res.json()) as CapabilityPage;
  const rows = async (res: Response) => (await page(res)).entries;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-capabilities-'));
    host = new SqliteScopeHost({ dir });
    host.registerModule(shareModule);
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(TENANT_SECRET, serviceActor),
      authenticateBuilder: firstBuilderAuth(pushTokenBuilderAuth(PUSH_SECRET)),
      tenantTokenSecret: TENANT_SECRET,
      pushTokenSecret: PUSH_SECRET,
    });
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    await host.admin.grantEntitlement(staff, t, 'share');
    s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s as never, vertical: 'share-vertical' });
    await host.admin.activateScope(staff, t, s as never);
    await host.admin.defineRole(staff, t, { key: 'owner', permissions: [READ], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: owner, roleKey: 'owner', node: { tenantId: t, scopeId: null } });

    const stub = await host.getScope(owner, t, s as never);
    link = await stub.invoke<MintedCapability>('doc/share', {
      entity: { entityType: 'folder', entityId: 'F1' },
      permissions: [READ],
      label: 'client review',
      maxUses: 4,
    });
    gone = await stub.invoke<MintedCapability>('doc/share', {
      entity: { entityType: 'folder', entityId: 'F2' },
      permissions: [READ],
      label: 'withdrawn',
    });
    await stub.invoke('doc/unshare', { id: gone.id });
    claim = await host.admin.mintCapability(staff, t, s as never, {
      principal: seat,
      expiresAt: inFuture(3_600_000),
      maxUses: 1,
      label: 'claim',
    });
    // Sessions hash too: exchange once so a session-token hash exists in the scope.
    await host.exchangeCapability(t, s as never, link.secret);

    const minted = await app.request('/tenant-tokens', {
      method: 'POST',
      headers: asStaff,
      body: JSON.stringify({ tenantId: t }),
    });
    expect(minted.status).toBe(201);
    asTenant = { [SERVICE_TOKEN_HEADER]: ((await minted.json()) as { token: string }).token, 'content-type': 'application/json' };
    const push = await mintPushToken(PUSH_SECRET, { actor: await pushActorFor(t), tenantId: t, tenantSlug: 'acme' });
    asBuilder = { [SERVICE_TOKEN_HEADER]: push, 'content-type': 'application/json' };
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('staff reads the directory: live by default, the revoked one when asked, narrowed by entity', async () => {
    const live = await get(route(), asStaff);
    expect(live.status).toBe(200);
    const liveRows = await rows(live);
    expect(liveRows.map((r) => r.id).sort()).toEqual([link.id, claim.id].sort());
    expect(liveRows.find((r) => r.id === link.id)).toMatchObject({
      mode: 'act',
      label: 'client review',
      entity: { entityType: 'folder', entityId: 'F1' },
      permissions: [READ],
      mintedBy: owner,
      maxUses: 4,
      uses: 1,
    });
    expect(liveRows.find((r) => r.id === claim.id)).toMatchObject({ mode: 'become', principal: seat });
    for (const r of liveRows) expect(capabilityRecord.parse(r)).toEqual(r);

    const all = await rows(await get(route(s, t, '?includeRevoked=true'), asStaff));
    expect(all.map((r) => r.id)).toContain(gone.id);
    expect(all.find((r) => r.id === gone.id)).toMatchObject({ revokedBy: owner });

    const onF2 = await rows(
      await get(route(s, t, '?entityType=folder&entityId=F2&includeRevoked=true'), asStaff),
    );
    expect(onF2.map((r) => r.id)).toEqual([gone.id]);
  });

  it('carries neither a secret nor a hash, in the body of any read', async () => {
    const res = await get(route(s, t, '?includeRevoked=true&limit=200'), asStaff);
    const text = await res.text();
    expect(JSON.parse(text).entries).toHaveLength(3); // the twin: a real, full read
    for (const m of [link, gone, claim]) {
      expect(text).toContain(m.id);
      expect(text).not.toContain(m.secret);
      expect(text).not.toContain(await capabilityTokenHash(m.secret));
    }
    expect(text).not.toMatch(HEX64);
  });

  it('REFUSES a tenant credential, and staff reads the same scope', async () => {
    const refused = await get(route(), asTenant);
    expect(refused.status).toBe(403);
    // The refusal says nothing about what is there.
    const body = await refused.text();
    for (const m of [link, claim]) expect(body).not.toContain(m.id);
    expect(body).not.toContain('client review');
    expect((await get(route(), asStaff)).status).toBe(200);
    // …and with every filter the route takes: a narrowing is no way round the gate.
    for (const q of ['?includeRevoked=true', '?entityType=folder&entityId=F1', '?limit=1']) {
      expect([q, (await get(route(s, t, q), asTenant)).status]).toEqual([q, 403]);
    }
  });

  it('REFUSES a builder, and staff reads the same scope', async () => {
    const refused = await get(route(), asBuilder);
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain(link.id);
    expect((await get(route(), asStaff)).status).toBe(200);
    expect((await get(route(s, t, '?includeRevoked=true'), asBuilder)).status).toBe(403);
  });

  it('refuses an unauthenticated read', async () => {
    expect((await get(route(), {})).status).toBe(401);
  });

  it('answers 404 for a scope of another tenant, and for one that does not exist', async () => {
    expect((await get(route(s, tenantId.parse(ulid())), asStaff)).status).toBe(404);
    expect((await get(route(scopeId.parse(ulid())), asStaff)).status).toBe(404);
  });

  it('pages: a cursor only while more follow, and the next page picks up after the last entry', async () => {
    // Three live records on this scope: the share link, the claim, and (revoked) the withdrawn one.
    const first = await page(await get(route(s, t, '?limit=1&includeRevoked=true'), asStaff));
    expect(first.entries).toHaveLength(1);
    expect(first.nextCursor).toBe(first.entries[0]!.id);
    const seen = [first.entries[0]!.id];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const next = await page(await get(route(s, t, `?limit=1&includeRevoked=true&cursor=${cursor}`), asStaff));
      seen.push(...next.entries.map((r) => r.id));
      cursor = next.nextCursor;
    }
    expect(seen.sort()).toEqual([link.id, gone.id, claim.id].sort());
    expect(new Set(seen).size).toBe(3); // no record twice
    // The twin: a page that holds everything carries no cursor.
    expect((await page(await get(route(s, t, '?includeRevoked=true'), asStaff))).nextCursor).toBeNull();
  });

  it('refuses a malformed filter rather than widening it', async () => {
    for (const q of ['?limit=201', '?limit=0', '?cursor=nope', '?cursor=', '?entityType=folder', '?entityId=F1', '?includeRevoked=maybe']) {
      expect([q, (await get(route(s, t, q), asStaff)).status]).toEqual([q, 400]);
    }
  });

  it('leaves a K-24 access row naming the method and the count, attributed to the staff actor', async () => {
    await get(route(s, t, '?includeRevoked=true'), asStaff);
    const log = (await host.admin.accessLog(staff, { method: 'listCapabilities' })).filter((e) => e.scopeId === s);
    expect(log.length).toBeGreaterThan(0);
    const last = log[log.length - 1]!;
    expect(last.actor).toBe(staff);
    expect(last.resultCount).toBe(3);
    expect(JSON.stringify(log)).not.toContain(link.secret);
  });

  describe('a scope a vertical’s own deployment serves', () => {
    const calls: { scopeId: string; filter: CapabilityFilter | undefined }[] = [];
    let delegated: ReturnType<typeof createControlPlaneApi>;
    let sV: string;

    beforeAll(async () => {
      sV = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: sV as never, vertical: 'hosted-vert' });
      await host.admin.activateScope(staff, t, sV as never);
      const fakeVertical = {
        listCapabilities: async (scope: string, filter?: CapabilityFilter) => {
          calls.push({ scopeId: scope, filter });
          return { entries: [], nextCursor: null } satisfies CapabilityPage;
        },
      } as unknown as VerticalClient;
      delegated = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        authenticateTenantService: tenantTokenAuth(TENANT_SECRET, serviceActor),
        authenticateBuilder: firstBuilderAuth(pushTokenBuilderAuth(PUSH_SECRET)),
        tenantTokenSecret: TENANT_SECRET,
        pushTokenSecret: PUSH_SECRET,
        verticals: { 'hosted-vert': fakeVertical },
      });
    });

    it('asks the vertical for staff, with the decoded filter, and records the read', async () => {
      const res = await get(route(sV, t, '?entityType=folder&entityId=F1&limit=5'), asStaff, delegated);
      expect(res.status).toBe(200);
      expect(calls).toEqual([
        { scopeId: sV, filter: { entity: { entityType: 'folder', entityId: 'F1' }, limit: 5 } },
      ]);
      const log = (await host.admin.accessLog(staff, { method: 'listCapabilities' })).filter((e) => e.scopeId === sV);
      expect(log).toHaveLength(1);
      expect(log[0]!.actor).toBe(staff);
    });

    it('refuses a tenant credential and a builder BEFORE the vertical is reached', async () => {
      const before = calls.length;
      expect((await get(route(sV), asTenant, delegated)).status).toBe(403);
      expect((await get(route(sV), asBuilder, delegated)).status).toBe(403);
      expect(calls.length).toBe(before);
      // The twin: staff on the same route and scope does reach it.
      expect((await get(route(sV), asStaff, delegated)).status).toBe(200);
      expect(calls.length).toBe(before + 1);
    });
  });
  /**
   * The operator's revoke over HTTP: `POST …/scopes/:s/capabilities/:id/revoke`. Its own scope, so
   * the read cases above keep the directory they count. Gated as the read is, and each refusal is
   * shown with its staff twin on the same route; a refusal writes nothing.
   */
  describe('POST …/capabilities/:id/revoke (#1686)', () => {
    let sR: string;
    let owner2: ReturnType<typeof principalId.parse>;
    const revokeRoute = (id: string, scope: string = sR, tenant: string = t) =>
      `/tenants/${tenant}/scopes/${scope}/capabilities/${id}/revoke`;
    const post = (path: string, headers: Record<string, string>, a = app) => a.request(path, { method: 'POST', headers });
    const mintLink = async (entityId: string) =>
      (await host.getScope(owner2, t, sR as never)).invoke<MintedCapability>('doc/share', {
        entity: { entityType: 'folder', entityId },
        permissions: [READ],
      });
    const exchanges = async (m: MintedCapability) => (await host.exchangeCapability(t, sR as never, m.secret)) !== null;
    const recordOf = async (id: string) =>
      (await host.admin.listCapabilities(staff, t, sR as never, { includeRevoked: true })).entries.find((r) => r.id === id)!;
    const revokeRows = async () =>
      (await host.admin.auditLog(staff)).filter((e) => e.action === 'revokeCapability' && e.scopeId === sR);
    const phasesOf = async (id: string) =>
      (await revokeRows())
        .filter((e) => (e.after as { capabilityId?: string }).capabilityId === id)
        .map((e) => (e.after as { phase: string }).phase);

    beforeAll(async () => {
      sR = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: sR as never, vertical: 'share-vertical' });
      await host.admin.activateScope(staff, t, sR as never);
      owner2 = principalId.parse(ulid());
      await host.admin.assignRole(staff, { principalId: owner2, roleKey: 'owner', node: { tenantId: t, scopeId: null } });
    });

    it('staff revokes: 204, the link stops exchanging, the record and the admin log name the operator', async () => {
      const leaked = await mintLink('R1');
      const sibling = await mintLink('R2');
      const res = await post(revokeRoute(leaked.id), asStaff);
      expect(res.status).toBe(204);
      expect(await exchanges(leaked)).toBe(false);
      expect(await recordOf(leaked.id)).toMatchObject({ revokedBy: { platform: staff } });
      // The intent, then the outcome: the same rows the hosted adapter writes (#1666's grammar).
      expect(await phasesOf(leaked.id)).toEqual(['intent', 'applied']);
      const row = (await revokeRows()).find(
        (e) => (e.after as { capabilityId?: string; phase: string }).capabilityId === leaked.id && (e.after as { phase: string }).phase === 'applied',
      );
      expect(row).toMatchObject({ actor: staff, after: { capabilityId: leaked.id, revoked: true } });
      expect(JSON.stringify(row)).not.toContain(leaked.secret);
      // The twin: the link beside it, never named, still opens.
      expect(await exchanges(sibling)).toBe(true);
      // Idempotent: the same revoke again is 204 again.
      expect((await post(revokeRoute(leaked.id), asStaff)).status).toBe(204);
    });

    it('REFUSES a tenant credential and a builder, revoking nothing — and staff revokes the same link', async () => {
      const link = await mintLink('R3');
      const rows = (await revokeRows()).length;
      for (const who of [asTenant, asBuilder]) {
        const refused = await post(revokeRoute(link.id), who);
        expect(refused.status).toBe(403);
        expect(await refused.text()).not.toContain(link.id);
      }
      expect((await recordOf(link.id)).revokedAt).toBeNull();
      expect(await exchanges(link)).toBe(true);
      expect((await revokeRows()).length).toBe(rows);
      expect((await post(revokeRoute(link.id), asStaff)).status).toBe(204);
      expect((await recordOf(link.id)).revokedAt).not.toBeNull();
    });

    it('refuses an unauthenticated revoke', async () => {
      const link = await mintLink('R4');
      expect((await post(revokeRoute(link.id), {})).status).toBe(401);
      expect((await recordOf(link.id)).revokedAt).toBeNull();
    });

    it('a capability the scope does not hold is 404, audited as refused — one minted in ANOTHER scope keeps working', async () => {
      const stranger = ulid();
      expect((await post(revokeRoute(stranger), asStaff)).status).toBe(404);
      // `link` lives in the outer scope `s`: named against `sR`, it is not found, and still opens.
      expect((await post(revokeRoute(link.id), asStaff)).status).toBe(404);
      expect(await phasesOf(stranger)).toEqual(['intent', 'refused']);
      expect(await phasesOf(link.id)).toEqual(['intent', 'refused']);
      expect(await host.exchangeCapability(t, s as never, link.secret)).not.toBeNull();
    });

    it('answers 404 for a scope of another tenant and one that does not exist, and 400 for a malformed id', async () => {
      const mine = await mintLink('R5');
      expect((await post(revokeRoute(mine.id, sR, tenantId.parse(ulid())), asStaff)).status).toBe(404);
      expect((await post(revokeRoute(mine.id, scopeId.parse(ulid())), asStaff)).status).toBe(404);
      expect((await post(revokeRoute('nope'), asStaff)).status).toBe(400);
      expect(await exchanges(mine)).toBe(true);
    });

    it("relays the far end's 501 \"redeploy\" verbatim rather than calling it done", async () => {
      const link = await mintLink('R6');
      const old = Object.create(host.admin) as typeof host.admin;
      old.revokeCapability = async () => {
        throw new ControlPlaneError(501, 'the deployment serving scope x predates the capability revoke (#1686) — redeploy the vertical, then retry. Nothing was revoked.');
      };
      const skewed = createControlPlaneApi({
        host: new Proxy(host, { get: (target, prop) => (prop === 'admin' ? old : Reflect.get(target, prop, target)) }),
        authenticate: UNSAFE_devPlatformActorAuth(),
      });
      const res = await post(revokeRoute(link.id), asStaff, skewed);
      expect(res.status).toBe(501);
      expect(await res.text()).toMatch(/redeploy the vertical/);
      expect(await exchanges(link)).toBe(true);
    });
  });
});
