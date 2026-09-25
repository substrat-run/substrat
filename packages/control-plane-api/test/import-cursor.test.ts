import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import {
  assertAllowed,
  runPlatformSweep,
  ulid,
  type ModuleRegistration,
  type OperationHandler,
} from '@substrat-run/kernel';
import {
  REPLAY_EFFECT,
  SKIP_EFFECT,
  moduleManifest,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PermissionKey,
  type ScopeId,
  type TenantId,
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
} from '../src/index.js';

/**
 * The replay lever over HTTP (#1705 PR 3): `POST /tenants/:t/scopes/:s/import-cursor`.
 *
 * WHO can actually call it is most of this file. Staff can, through the console. A tenant's own
 * credential can, which is the one the dashboard holds for someone who may manage the tenant's
 * apps, and it is confined hard to that tenant. A builder's push token cannot. Each refusal is
 * paired with its twin, and each asserts that the watermark did NOT move, because a 403 that had
 * already moved it would pass a status-only check.
 */
const PRODUCER = 'acme/ledger';
const CONSUMER = 'acme/desk';
const key = (k: string): PermissionKey => permissionKey.parse(k);

const ledger: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: '@test/ledger',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [
      { key: 'ledger:write', description: 'write the ledger' },
      { key: 'ledger:read', description: 'read the ledger' },
    ],
    events: {
      emits: [{ type: 'ledger.entry-made', schemaVersion: 1 }],
      consumes: [],
      exports: [{ type: 'ledger.entry-made', schemaVersion: 1, readPermission: 'ledger:read' }],
    },
    peers: [{ vertical: CONSUMER, operations: [], permissions: ['ledger:read'] }],
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'ledger',
  }),
  migrations: [],
  operations: {
    'ledger/make': (async (ctx) => {
      assertAllowed(await ctx.check(key('ledger:write')));
      const id = ulid();
      ctx.emit({
        type: 'ledger.entry-made',
        schemaVersion: 1,
        entity: { entityType: 'entry', entityId: id },
        piiClass: 'none',
        payload: { id },
      });
      return { id };
    }) as OperationHandler<never, unknown>,
  },
};

const desk: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: '@test/desk',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [{ key: 'desk:sync', description: 'keep the desk in step' }],
    events: { emits: [], consumes: [{ from: PRODUCER, type: 'ledger.entry-made', schemaVersion: 1 }] },
    peers: [{ vertical: PRODUCER, operations: [], permissions: ['desk:sync'] }],
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'desk',
  }),
  migrations: [{ version: '0001-init', sql: 'CREATE TABLE desk_entries (id TEXT PRIMARY KEY)' }],
  operations: {},
  imports: {
    [PRODUCER]: {
      'ledger.entry-made': async (ctx, event) => {
        assertAllowed(await ctx.check(key('desk:sync')));
        ctx.sql.exec('INSERT OR IGNORE INTO desk_entries (id) VALUES (?)', [(event.payload as { id: string }).id]);
      },
    },
  },
};

describe('the replay lever route (#1705 PR 3)', () => {
  const TENANT_SECRET = 'test-tenant-token-secret';
  const PUSH_SECRET = 'test-push-token-secret';
  const t = tenantId.parse(ulid());
  const other = tenantId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const writer = principalId.parse(ulid());
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  let asTenant: Record<string, string>;
  let asOtherTenant: Record<string, string>;
  let asBuilder: Record<string, string>;
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  let consumerScope: ScopeId;
  let otherConsumer: ScopeId;

  const route = (s: string, tenant: string = t) => `/tenants/${tenant}/scopes/${s}/import-cursor`;
  const post = (path: string, headers: Record<string, string>, body: unknown) =>
    app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const skipNow = { mode: 'skip', from: PRODUCER, through: 'now', acknowledge: 'skip-events', reason: 'start from today' };
  const replayAll = {
    mode: 'replay',
    from: PRODUCER,
    after: null,
    acknowledge: 'rerun-handlers',
    reason: 'the desk lost its entries',
  };
  const cursorOf = async (tenant: TenantId, s: ScopeId) =>
    (await host.admin.importState(staff, tenant, s)).cursors.map((c) => c.cursor);

  const install = async (tenant: TenantId, vertical: string): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: tenant, scopeId: s, vertical });
    await host.admin.activateScope(staff, tenant, s);
    return s;
  };
  const tokenFor = async (tenant: string) => {
    const minted = await app.request('/tenant-tokens', {
      method: 'POST',
      headers: asStaff,
      body: JSON.stringify({ tenantId: tenant }),
    });
    expect(minted.status).toBe(201);
    return { [SERVICE_TOKEN_HEADER]: ((await minted.json()) as { token: string }).token, 'content-type': 'application/json' };
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-import-cursor-'));
    host = new SqliteScopeHost({ dir });
    host.registerModule(ledger);
    host.registerModule(desk);
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(TENANT_SECRET, serviceActor),
      authenticateBuilder: firstBuilderAuth(pushTokenBuilderAuth(PUSH_SECRET)),
      tenantTokenSecret: TENANT_SECRET,
      pushTokenSecret: PUSH_SECRET,
    });
    for (const [tenant, slug] of [
      [t, 'acme'],
      [other, 'other'],
    ] as const) {
      await host.admin.createTenant(staff, { id: tenant, slug, name: slug });
      await host.admin.grantEntitlement(staff, tenant, 'ledger');
      await host.admin.grantEntitlement(staff, tenant, 'desk');
    }
    const producer = await install(t, PRODUCER);
    consumerScope = await install(t, CONSUMER);
    await install(other, PRODUCER);
    otherConsumer = await install(other, CONSUMER);
    await host.admin.grant(staff, {
      principalId: writer,
      permission: key('ledger:write'),
      node: { tenantId: t, scopeId: producer },
      grantedBy: writer,
    });
    await (await host.getScope(writer, t, producer)).invoke('ledger/make', {});
    await runPlatformSweep(host, {
      actor: staff,
      fetch: async () => new Response('unused'),
      sweepers: {},
      drainRetries: false,
      gcSnapshots: false,
      reconcileMigrations: false,
      runSchedules: false,
      crossVertical: {},
    });
    expect(await cursorOf(t, consumerScope)).toHaveLength(1);

    asTenant = await tokenFor(t);
    asOtherTenant = await tokenFor(other);
    const push = await mintPushToken(PUSH_SECRET, { actor: await pushActorFor(t), tenantId: t, tenantSlug: 'acme' });
    asBuilder = { [SERVICE_TOKEN_HEADER]: push, 'content-type': 'application/json' };
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("another tenant's credential is refused, and nothing moves; the tenant's own moves it", async () => {
    const before = await cursorOf(t, consumerScope);
    const refused = await post(route(consumerScope), asOtherTenant, replayAll);
    expect(refused.status).toBe(403);
    expect(await cursorOf(t, consumerScope)).toEqual(before);
    // Its own scope's id under the wrong tenant is refused as well.
    const confused = await post(route(otherConsumer, t), asOtherTenant, replayAll);
    expect(confused.status).toBe(403);

    // The twin: the tenant's own credential, on its own scope.
    const ok = await post(route(consumerScope), asTenant, replayAll);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ mode: 'replay', cursor: null, archived: { journal: 1, deliveries: 1 } });
  });

  it("a builder's push token is refused, and nothing moves; staff moves it", async () => {
    const before = await cursorOf(t, consumerScope);
    const refused = await post(route(consumerScope), asBuilder, skipNow);
    expect(refused.status).toBe(403);
    expect(await cursorOf(t, consumerScope)).toEqual(before);

    const ok = await post(route(consumerScope), asStaff, skipNow);
    expect(ok.status).toBe(200);
    expect(await cursorOf(t, consumerScope)).not.toEqual(before);
  });

  it('a scope of another tenant, named under this one by staff, is not found', async () => {
    const res = await post(route(otherConsumer, t), asStaff, skipNow);
    expect(res.status).toBe(404);
  });

  it('a missing acknowledgement is refused in the words it stands for, and nothing moves', async () => {
    const before = await cursorOf(t, consumerScope);
    const { acknowledge: _r, ...bareReplay } = replayAll;
    const r = await post(route(consumerScope), asStaff, bareReplay);
    expect(r.status).toBe(400);
    const said = ((await r.json()) as { error: string }).error;
    expect(said).toContain(REPLAY_EFFECT);
    expect(said).toContain('anything they send or call outside this app happens again');

    // The other mode's literal is no acknowledgement of this one.
    const crossed = await post(route(consumerScope), asStaff, { ...replayAll, acknowledge: 'skip-events' });
    expect(crossed.status).toBe(400);
    expect(((await crossed.json()) as { error: string }).error).toContain(REPLAY_EFFECT);

    const { acknowledge: _s, ...bareSkip } = skipNow;
    const s = await post(route(consumerScope), asStaff, bareSkip);
    expect(s.status).toBe(400);
    expect(((await s.json()) as { error: string }).error).toContain(SKIP_EFFECT);
    expect(await cursorOf(t, consumerScope)).toEqual(before);
  });
});

describe('the edge health route (#1705 PR 3)', () => {
  const TENANT_SECRET = 'test-tenant-token-secret';
  const t = tenantId.parse(ulid());
  const other = tenantId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const writer = principalId.parse(ulid());
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  let consumer: ScopeId;
  let producer: ScopeId;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-edge-health-'));
    host = new SqliteScopeHost({ dir });
    host.registerModule(ledger);
    host.registerModule(desk);
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(TENANT_SECRET, serviceActor),
      tenantTokenSecret: TENANT_SECRET,
    });
    for (const [tenant, slug] of [
      [t, 'acme'],
      [other, 'other'],
    ] as const) {
      await host.admin.createTenant(staff, { id: tenant, slug, name: slug });
      await host.admin.grantEntitlement(staff, tenant, 'ledger');
      await host.admin.grantEntitlement(staff, tenant, 'desk');
    }
    const install = async (tenant: TenantId, vertical: string) => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: tenant, scopeId: s, vertical });
      await host.admin.activateScope(staff, tenant, s);
      return s;
    };
    producer = await install(t, PRODUCER);
    consumer = await install(t, CONSUMER);
    await install(other, CONSUMER);
    await host.admin.grant(staff, {
      principalId: writer,
      permission: key('ledger:write'),
      node: { tenantId: t, scopeId: producer },
      grantedBy: writer,
    });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const edges = async (tenant: string, headers: Record<string, string>) => {
    const res = await app.request(`/tenants/${tenant}/cross-vertical/edges`, { headers });
    return { status: res.status, body: (await res.json()) as { edges: { consumer: { scopeId: string }; state: string; lastDelivered: unknown }[] } };
  };

  it('reads the durable sweep history beside the live state: the pass that delivered', async () => {
    await (await host.getScope(writer, t, producer)).invoke('ledger/make', {});
    const before = await edges(t, asStaff);
    expect(before.status).toBe(200);
    expect(before.body.edges.find((e) => e.consumer.scopeId === consumer)).toMatchObject({ state: 'behind', lastDelivered: null });

    await runPlatformSweep(host, {
      actor: staff,
      fetch: async () => new Response('unused'),
      sweepers: {},
      drainRetries: false,
      gcSnapshots: false,
      reconcileMigrations: false,
      runSchedules: false,
      recordSweepRun: (e) => host.admin.recordSweepRun(e),
      crossVertical: {},
    });
    const after = await edges(t, asStaff);
    expect(after.body.edges.find((e) => e.consumer.scopeId === consumer)).toMatchObject({
      state: 'caught-up',
      lastDelivered: { at: expect.any(String) },
    });
  });

  it("another tenant's credential is refused; the tenant's own reads its own edges only", async () => {
    const asOther = await app.request('/tenant-tokens', { method: 'POST', headers: asStaff, body: JSON.stringify({ tenantId: other }) });
    const otherToken = { [SERVICE_TOKEN_HEADER]: ((await asOther.json()) as { token: string }).token };
    expect((await edges(t, otherToken)).status).toBe(403);
    const own = await edges(other, otherToken);
    expect(own.status).toBe(200);
    // other's consumer has no producer in its tenant: unresolved, never t's producer.
    expect(own.body.edges.every((e) => e.consumer.scopeId !== consumer)).toBe(true);
    expect(own.body.edges.map((e) => e.state)).toEqual(['unresolved']);
  });
});
