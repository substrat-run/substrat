import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { assertAllowed, ulid, type ModuleRegistration, type OperationHandler } from '@substrat-run/kernel';
import {
  moduleManifest,
  platformActorId,
  scopeId,
  tenantId,
  type PermissionKey,
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
 * The peer kill switch over HTTP (#1706): `DELETE` cuts one of a tenant's apps off from
 * another's scope, `POST` gives it back, `GET` says where every peer stands — the surface
 * the console and the dashboard's install disclosure are both built on.
 *
 * The one thing that genuinely differs from the schedule switch's routes (#1666) is WHO may
 * pull it, and that is the property most of this file is about: "may my other app still call
 * into here" is a tenant's question about its own two apps, so a tenant's own credential is
 * admitted — and confined, hard, to that tenant. No vertical holds such a credential at all
 * (a vertical is CP-less), so the switched party still cannot switch itself back on.
 *
 * Every refusal is paired with its positive twin on the same route, and each refusal also
 * asserts the switch did NOT move: a 403 that had already switched would pass a status-only
 * check.
 */
const CALLER = 'acme/board-room';
const LISTENER = 'acme/ledger';

const deskModule: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: '@test/desk',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [{ key: 'desk:read', description: 'read the desk' }],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'desk',
    peers: [
      { vertical: CALLER, operations: ['desk/list'], permissions: ['desk:read'] },
      { vertical: LISTENER, operations: [], permissions: ['desk:read'] },
    ],
  }),
  migrations: [{ version: '0001-init', sql: 'CREATE TABLE desks (id TEXT PRIMARY KEY)' }],
  operations: {
    'desk/list': (async (ctx) => {
      assertAllowed(await ctx.check('desk:read' as PermissionKey));
      return ctx.sql.query('SELECT id FROM desks');
    }) as OperationHandler<never, unknown>,
  },
};

describe('the peer switch routes (#1706)', () => {
  const TENANT_SECRET = 'test-tenant-token-secret';
  const PUSH_SECRET = 'test-push-token-secret';
  const t = tenantId.parse(ulid());
  const other = tenantId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  let asTenant: Record<string, string>;
  let asOtherTenant: Record<string, string>;
  let asBuilder: Record<string, string>;
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;

  const route = (s: string, tenant: string = t) => `/tenants/${tenant}/scopes/${s}/peer-grants`;
  const send = (method: 'DELETE' | 'POST', path: string, headers: Record<string, string>, body: unknown) =>
    app.request(path, { method, headers, body: JSON.stringify(body) });
  const get = (path: string, headers: Record<string, string>) => app.request(path, { headers });
  const off = { vertical: CALLER, reason: 'the board-room app is leaking' };
  const on = { vertical: CALLER, reason: 'resolved' };

  const newScope = async (tenant = t) => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: tenant, scopeId: s, vertical: 'desk-vertical' });
    await host.admin.activateScope(staff, tenant, s);
    return s;
  };
  /** Where the peer stands, as the DOOR sees it — the only answer that matters. */
  const held = async (s: string, vertical = CALLER) =>
    (await host.peerCovers(t, scopeId.parse(s), vertical, ['desk:read' as PermissionKey])).every((c) => c.held);

  const tokenFor = async (tenant: string) => {
    const minted = await app.request('/tenant-tokens', {
      method: 'POST',
      headers: asStaff,
      body: JSON.stringify({ tenantId: tenant }),
    });
    expect(minted.status).toBe(201);
    return {
      [SERVICE_TOKEN_HEADER]: ((await minted.json()) as { token: string }).token,
      'content-type': 'application/json',
    };
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-peer-switch-'));
    host = new SqliteScopeHost({ dir });
    host.registerModule(deskModule);
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(TENANT_SECRET, serviceActor),
      authenticateBuilder: firstBuilderAuth(pushTokenBuilderAuth(PUSH_SECRET)),
      tenantTokenSecret: TENANT_SECRET,
      pushTokenSecret: PUSH_SECRET,
    });
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    await host.admin.grantEntitlement(staff, t, 'desk');
    await host.admin.createTenant(staff, { id: other, slug: 'other', name: 'Other' });
    await host.admin.grantEntitlement(staff, other, 'desk');

    asTenant = await tokenFor(t);
    asOtherTenant = await tokenFor(other);
    const push = await mintPushToken(PUSH_SECRET, { actor: await pushActorFor(t), tenantId: t, tenantSlug: 'acme' });
    asBuilder = { [SERVICE_TOKEN_HEADER]: push, 'content-type': 'application/json' };
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('staff switches a peer off and back on, and each move is on the admin log with its reason', async () => {
    const s = await newScope();
    expect(await held(s)).toBe(true);

    const down = await send('DELETE', route(s), asStaff, off);
    expect(down.status).toBe(200);
    expect(await down.json()).toEqual({
      operationId: expect.any(String),
      vertical: CALLER,
      calls: 'off',
      changed: true,
      permissions: ['desk:read'],
    });
    expect(await held(s)).toBe(false);

    const up = await send('POST', route(s), asStaff, on);
    expect(up.status).toBe(200);
    expect(await up.json()).toMatchObject({ vertical: CALLER, calls: 'on', changed: true });
    expect(await held(s)).toBe(true);

    const log = await get(`/admin-log?tenantId=${t}&scopeId=${s}&action=revokeFromPeer&action=restoreToPeer`, asStaff);
    const rows = ((await log.json()) as { entries: { action: string; after: { phase: string; reason?: string } }[] })
      .entries;
    expect(rows.map((r) => [r.action, r.after.phase])).toEqual([
      ['revokeFromPeer', 'intent'],
      ['revokeFromPeer', 'applied'],
      ['restoreToPeer', 'intent'],
      ['restoreToPeer', 'applied'],
    ]);
    expect(rows[0]!.after.reason).toBe(off.reason);
  });

  it("a tenant may pull the switch on its OWN scope — the lever exists for the tenant's own two apps", async () => {
    const s = await newScope();
    expect((await send('DELETE', route(s), asTenant, off)).status).toBe(200);
    expect(await held(s)).toBe(false);
    expect((await send('POST', route(s), asTenant, on)).status).toBe(200);
    expect(await held(s)).toBe(true);
  });

  it("another tenant's credential cannot reach this tenant's scope, and nothing moves", async () => {
    const s = await newScope();
    // The path names THIS tenant; the credential is pinned to the other one.
    expect((await send('DELETE', route(s), asOtherTenant, off)).status).toBe(403);
    expect(await held(s)).toBe(true);
    expect((await get(route(s), asOtherTenant)).status).toBe(403);
  });

  it('a scope of another tenant, named under this one, reads as absent — not as a peer to switch', async () => {
    const elsewhere = await newScope(other);
    const res = await send('DELETE', route(elsewhere), asStaff, off);
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).toMatch(/unknown scope for tenant/);
    expect((await get(route(elsewhere), asStaff)).status).toBe(404);
  });

  it('a builder token is refused by default-deny, and nothing moves', async () => {
    const s = await newScope();
    expect((await send('DELETE', route(s), asBuilder, off)).status).toBe(403);
    expect(await held(s)).toBe(true);
  });

  it('the status read says where every peer stands, and explains an OFF one', async () => {
    const s = await newScope();
    expect(await (await get(route(s), asStaff)).json()).toEqual([
      { vertical: CALLER, calls: 'on', switchedOff: null },
      { vertical: LISTENER, calls: 'on', switchedOff: null },
    ]);

    expect((await send('DELETE', route(s), asStaff, off)).status).toBe(200);
    const after = (await (await get(route(s), asTenant)).json()) as {
      vertical: string;
      calls: string;
      switchedOff: { actor: string; reason: string; at: string } | null;
    }[];
    expect(after).toEqual([
      {
        vertical: CALLER,
        calls: 'off',
        switchedOff: { actor: staff, reason: off.reason, at: expect.any(String) },
      },
      { vertical: LISTENER, calls: 'on', switchedOff: null },
    ]);
  });

  it('a peer the scope never held writes nothing and answers 404, so a typo plants no marker', async () => {
    const s = await newScope();
    const res = await send('DELETE', route(s), asStaff, { vertical: 'acme/stranger', reason: 'typo' });
    expect(res.status).toBe(404);
    // And the view is unchanged: nothing was recorded for a peer that was never here.
    expect(
      ((await (await get(route(s), asStaff)).json()) as { vertical: string }[]).map((p) => p.vertical),
    ).toEqual([CALLER, LISTENER]);
  });

  it('a reason is required, and an unknown field is refused — the body is strict', async () => {
    const s = await newScope();
    // No reason: a kill switch with no recorded why is not a kill switch.
    expect((await send('DELETE', route(s), asStaff, { vertical: CALLER })).status).toBe(400);
    // A body that tries to name its own node cannot redirect the switch: the path decides
    // the (tenant, scope), and `.strict()` refuses the extra key rather than ignoring it.
    expect(
      (await send('DELETE', route(s), asStaff, { vertical: CALLER, reason: 'r', node: { tenantId: other } })).status,
    ).toBe(400);
    expect(await held(s)).toBe(true);
  });
});
