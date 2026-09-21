import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { assertAllowed, ulid, type ModuleRegistration, type OperationHandler } from '@substrat-run/kernel';
import {
  moduleId,
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
 * The schedule kill switch over HTTP (#1666): `DELETE` turns one module's schedules off
 * on one scope, `POST` turns them back on, both staff-only and both audited with a reason.
 *
 * Every refusal is paired with its positive twin on the same route, and each refusal also
 * asserts the switch did NOT move — a 403 that had already switched would pass a
 * status-only check.
 */
const TICK = moduleId.parse('@test/tick');

const tickModule: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: TICK,
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [{ key: 'tick:run', description: 'run the tick' }],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'tick',
    schedules: [{ operation: 'tick/run', cadence: { everyMinutes: 60 }, permissions: ['tick:run'] }],
  }),
  migrations: [{ version: '0001-init', sql: 'CREATE TABLE ticks (at TEXT NOT NULL)' }],
  operations: {
    'tick/run': (async (ctx) => {
      assertAllowed(await ctx.check('tick:run' as PermissionKey));
      ctx.sql.exec('INSERT INTO ticks (at) VALUES (?)', [ctx.now()]);
    }) as OperationHandler<never, unknown>,
  },
};

describe('the schedule switch routes (#1666)', () => {
  const TENANT_SECRET = 'test-tenant-token-secret';
  const PUSH_SECRET = 'test-push-token-secret';
  const t = tenantId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  let asTenant: Record<string, string>;
  let asBuilder: Record<string, string>;
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;

  const route = (s: string, tenant: string = t) => `/tenants/${tenant}/scopes/${s}/system-grants`;
  const send = (method: 'DELETE' | 'POST', path: string, headers: Record<string, string>, body: unknown) =>
    app.request(path, { method, headers, body: JSON.stringify(body) });
  const off = { moduleId: TICK, reason: 'incident: runaway tick' };
  const on = { moduleId: TICK, reason: 'resolved' };

  const newScope = async () => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'tick-vertical' });
    await host.admin.activateScope(staff, t, s);
    return s;
  };
  /** Where the switch stands, as the runner sees it — the only answer that matters. */
  const state = async (s: string) => {
    const r = await host.runDueSchedules(TICK, t, scopeId.parse(s));
    return r.switchedOff ? 'off' : r.fired + r.skipped > 0 ? 'on' : 'none';
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-schedule-switch-'));
    host = new SqliteScopeHost({ dir });
    host.registerModule(tickModule);
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(TENANT_SECRET, serviceActor),
      authenticateBuilder: firstBuilderAuth(pushTokenBuilderAuth(PUSH_SECRET)),
      tenantTokenSecret: TENANT_SECRET,
      pushTokenSecret: PUSH_SECRET,
    });
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    await host.admin.grantEntitlement(staff, t, 'tick');

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

  it('staff switches a module off and back on, and each move is on the admin log with its reason', async () => {
    const s = await newScope();
    const down = await send('DELETE', route(s), asStaff, off);
    expect(down.status).toBe(200);
    expect(await down.json()).toEqual({ moduleId: TICK, schedules: 'off', changed: true, permissions: ['tick:run'] });
    expect(await state(s)).toBe('off');

    const up = await send('POST', route(s), asStaff, on);
    expect(up.status).toBe(200);
    expect(await up.json()).toEqual({ moduleId: TICK, schedules: 'on', changed: true, permissions: ['tick:run'] });
    expect(await state(s)).toBe('on');

    // Confirming it afterwards is a read of the same log an operator reads.
    const log = await app.request(
      `/admin-log?tenantId=${t}&scopeId=${s}&action=revokeFromSystem&action=restoreToSystem`,
      { headers: asStaff },
    );
    expect(log.status).toBe(200);
    const entries = ((await log.json()) as { entries: { action: string; actor: string; after: unknown }[] }).entries;
    expect(entries.map((e) => ({ action: e.action, actor: e.actor, after: e.after }))).toEqual([
      {
        action: 'revokeFromSystem',
        actor: staff,
        after: { moduleId: TICK, schedules: 'off', permissions: ['tick:run'], reason: 'incident: runaway tick' },
      },
      {
        action: 'restoreToSystem',
        actor: staff,
        after: { moduleId: TICK, schedules: 'on', permissions: ['tick:run'], reason: 'resolved' },
      },
    ]);
  });

  it("REFUSES the tenant's own credential both ways — the switched party cannot switch itself back on", async () => {
    const s = await newScope();
    // Off, as a tenant: refused, and nothing moved.
    expect((await send('DELETE', route(s), asTenant, off)).status).toBe(403);
    expect(await state(s)).toBe('on');

    // Staff pulls it (the positive twin on the same route)…
    expect((await send('DELETE', route(s), asStaff, off)).status).toBe(200);
    // …and the tenant's credential cannot undo that. This is the half that makes it a switch.
    expect((await send('POST', route(s), asTenant, on)).status).toBe(403);
    expect(await state(s)).toBe('off');
    expect((await send('POST', route(s), asStaff, on)).status).toBe(200);
    expect(await state(s)).toBe('on');
  });

  it('REFUSES a builder both ways, and nothing moves', async () => {
    const s = await newScope();
    expect((await send('DELETE', route(s), asBuilder, off)).status).toBe(403);
    expect(await state(s)).toBe('on');
    expect((await send('DELETE', route(s), asStaff, off)).status).toBe(200);
    expect((await send('POST', route(s), asBuilder, on)).status).toBe(403);
    expect(await state(s)).toBe('off');
  });

  it('refuses a missing reason, and a body that tries to name the scope', async () => {
    const s = await newScope();
    expect((await send('DELETE', route(s), asStaff, { moduleId: TICK })).status).toBe(400);
    expect((await send('DELETE', route(s), asStaff, { moduleId: TICK, reason: '' })).status).toBe(400);
    expect((await send('DELETE', route(s), asStaff, { ...off, scopeId: ulid() })).status).toBe(400);
    expect(await state(s)).toBe('on');
  });

  it('answers 404 for a module the scope never held, and for a scope of another tenant', async () => {
    const s = await newScope();
    const typo = await send('DELETE', route(s), asStaff, { moduleId: '@test/tock', reason: 'r' });
    expect(typo.status).toBe(404);
    expect(JSON.stringify(await typo.json())).toMatch(/holds no system grant for module '@test\/tock'/);
    const foreign = await send('DELETE', route(s, tenantId.parse(ulid())), asStaff, off);
    expect(foreign.status).toBe(404);
    expect(await state(s)).toBe('on');
  });

  it('is idempotent — a repeat answers changed: false', async () => {
    const s = await newScope();
    await send('DELETE', route(s), asStaff, off);
    const again = await send('DELETE', route(s), asStaff, off);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ schedules: 'off', changed: false, permissions: [] });
  });
});
