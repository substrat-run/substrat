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
  type CapabilityRecord,
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
  operations: {
    'doc/share': (async (ctx, input) => {
      assertAllowed(await ctx.check(READ));
      return ctx.capabilities.mint(input as Parameters<typeof ctx.capabilities.mint>[0]);
    }) as OperationHandler<never, unknown>,
    'doc/unshare': (async (ctx, input) => {
      assertAllowed(await ctx.check(READ));
      await ctx.capabilities.revoke((input as { id: never }).id);
    }) as OperationHandler<never, unknown>,
  },
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
  const rows = async (res: Response) => (await res.json()) as CapabilityRecord[];

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
    expect(JSON.parse(text)).toHaveLength(3); // the twin: a real, full read
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

  it('refuses a malformed filter rather than widening it', async () => {
    for (const q of ['?limit=201', '?limit=0', '?entityType=folder', '?entityId=F1', '?includeRevoked=maybe']) {
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
          return [];
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
});
