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
  type VerticalClient,
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
    const downBody = (await down.json()) as { operationId: string };
    expect(downBody).toEqual({
      operationId: expect.any(String),
      moduleId: TICK,
      schedules: 'off',
      changed: true,
      permissions: ['tick:run'],
    });
    expect(await state(s)).toBe('off');

    const up = await send('POST', route(s), asStaff, on);
    expect(up.status).toBe(200);
    const upBody = (await up.json()) as { operationId: string };
    expect(upBody).toEqual({
      operationId: expect.any(String),
      moduleId: TICK,
      schedules: 'on',
      changed: true,
      permissions: ['tick:run'],
    });
    expect(await state(s)).toBe('on');

    // Confirming it afterwards is a read of the same log an operator reads.
    const log = await app.request(
      `/admin-log?tenantId=${t}&scopeId=${s}&action=revokeFromSystem&action=restoreToSystem`,
      { headers: asStaff },
    );
    expect(log.status).toBe(200);
    const entries = ((await log.json()) as { entries: { action: string; actor: string; after: unknown }[] }).entries;
    // Audit first: each call's intent (with its reason), then its outcome, paired by the
    // operation id the route answered with.
    const off1 = { action: 'revokeFromSystem', actor: staff, operationId: downBody.operationId, moduleId: TICK, schedules: 'off' };
    const on1 = { action: 'restoreToSystem', actor: staff, operationId: upBody.operationId, moduleId: TICK, schedules: 'on' };
    expect(entries.map((e) => ({ action: e.action, actor: e.actor, ...(e.after as Record<string, unknown>) }))).toEqual([
      { ...off1, phase: 'intent', reason: 'incident: runaway tick' },
      { ...off1, phase: 'applied', changed: true, permissions: ['tick:run'] },
      { ...on1, phase: 'intent', reason: 'resolved' },
      { ...on1, phase: 'applied', changed: true, permissions: ['tick:run'] },
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

  it("the runbook's confirm step: the scope's SQL console shows the switch position", async () => {
    // The exact statement the CHECKPOINT's emergency runbook gives an operator. There is no
    // dedicated status read yet, so this read has to keep working, and this pins it.
    const s = await newScope();
    const confirm = async () => {
      const res = await send('POST', `/tenants/${t}/scopes/${s}/query`, asStaff, {
        sql: `SELECT relation, revoked_at FROM _substrat_tuples WHERE subject = 'system:${TICK}' ORDER BY relation`,
      });
      expect(res.status).toBe(200);
      const { columns, rows } = (await res.json()) as { columns: string[]; rows: unknown[][] };
      return rows.map((r) => ({
        relation: r[columns.indexOf('relation')],
        revoked: r[columns.indexOf('revoked_at')] !== null,
      }));
    };
    expect(await confirm()).toEqual([{ relation: 'granted:tick:run', revoked: false }]);
    await send('DELETE', route(s), asStaff, off);
    // OFF: the marker is live, the grant revoked, and the record of what OFF took live.
    expect(await confirm()).toEqual([
      { relation: 'granted:tick:run', revoked: true },
      { relation: 'switch:off', revoked: false },
      { relation: 'switched:tick:run', revoked: false },
    ]);
    await send('POST', route(s), asStaff, on);
    // ON: the grant is live again; the marker and the record stay as evidence, revoked.
    expect(await confirm()).toEqual([
      { relation: 'granted:tick:run', revoked: false },
      { relation: 'switch:off', revoked: true },
      { relation: 'switched:tick:run', revoked: true },
    ]);
  });

  it('is idempotent — a repeat answers changed: false', async () => {
    const s = await newScope();
    await send('DELETE', route(s), asStaff, off);
    const again = await send('DELETE', route(s), asStaff, off);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ schedules: 'off', changed: false, permissions: [] });
  });
});

/**
 * The status read (#1674): `GET .../system-grants` — "is this module switched off on this
 * scope?", without the scope's own SQL console. Same staff-only gate as the switch, and
 * the SAME `systemScheduleState` predicate `runDueSchedules` gates on, so a read that
 * disagreed with what the runner just did would fail here.
 */
describe('the status read route (#1674)', () => {
  const TENANT_SECRET = 'test-tenant-token-secret';
  const PUSH_SECRET = 'test-push-token-secret';
  const t = tenantId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SR');
  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  let asTenant: Record<string, string>;
  let asBuilder: Record<string, string>;
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;

  const route = (s: string, tenant: string = t) => `/tenants/${tenant}/scopes/${s}/system-grants`;
  const get = (path: string, headers: Record<string, string>) => app.request(path, { method: 'GET', headers });
  const off = (s: string, reason = 'incident: runaway tick') =>
    app.request(route(s), {
      method: 'DELETE',
      headers: asStaff,
      body: JSON.stringify({ moduleId: TICK, reason }),
    });
  const on = (s: string) =>
    app.request(route(s), {
      method: 'POST',
      headers: asStaff,
      body: JSON.stringify({ moduleId: TICK, reason: 'resolved' }),
    });

  const newScope = async () => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'tick-vertical' });
    await host.admin.activateScope(staff, t, s);
    return s;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-schedule-switch-status-'));
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
    await host.admin.createTenant(staff, { id: t, slug: 'acme-status', name: 'Acme' });
    await host.admin.grantEntitlement(staff, t, 'tick');

    const minted = await app.request('/tenant-tokens', {
      method: 'POST',
      headers: asStaff,
      body: JSON.stringify({ tenantId: t }),
    });
    expect(minted.status).toBe(201);
    asTenant = { [SERVICE_TOKEN_HEADER]: ((await minted.json()) as { token: string }).token, 'content-type': 'application/json' };
    const push = await mintPushToken(PUSH_SECRET, { actor: await pushActorFor(t), tenantId: t, tenantSlug: 'acme-status' });
    asBuilder = { [SERVICE_TOKEN_HEADER]: push, 'content-type': 'application/json' };
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads on, off (with who/when/why), and on again, agreeing with the runner at each step', async () => {
    const s = await newScope();
    const runnerState = async () => {
      const r = await host.runDueSchedules(TICK, t, scopeId.parse(s));
      return r.switchedOff ? 'off' : 'on';
    };

    const initial = await get(route(s), asStaff);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual([{ moduleId: TICK, schedules: 'on', switchedOff: null, recorded: null }]);
    expect(await runnerState()).toBe('on');

    const before = new Date().toISOString();
    await off(s);
    const offRead = await get(route(s), asStaff);
    expect(offRead.status).toBe(200);
    const offEntries = (await offRead.json()) as { moduleId: string; schedules: string; switchedOff: { actor: string; reason: string; at: string } | null }[];
    expect(offEntries).toEqual([
      {
        moduleId: TICK,
        schedules: 'off',
        switchedOff: { actor: staff, reason: 'incident: runaway tick', at: expect.any(String) },
        recorded: 'off',
      },
    ]);
    expect(offEntries[0]!.switchedOff!.at >= before).toBe(true);
    expect(await runnerState()).toBe('off');

    await on(s);
    const onRead = await get(route(s), asStaff);
    expect(await onRead.json()).toEqual([{ moduleId: TICK, schedules: 'on', switchedOff: null, recorded: 'on' }]);
    expect(await runnerState()).toBe('on');
  });

  it("REFUSES the tenant's own credential, with staff reading the same route as the positive twin", async () => {
    const s = await newScope();
    expect((await get(route(s), asTenant)).status).toBe(403);
    expect((await get(route(s), asStaff)).status).toBe(200);
  });

  it('REFUSES a builder, with staff reading the same route as the positive twin', async () => {
    const s = await newScope();
    expect((await get(route(s), asBuilder)).status).toBe(403);
    expect((await get(route(s), asStaff)).status).toBe(200);
  });

  it('answers 404 for a scope of another tenant', async () => {
    const s = await newScope();
    const foreign = await get(route(s, tenantId.parse(ulid())), asStaff);
    expect(foreign.status).toBe(404);
  });
});

/**
 * The fleet read (#1674): `GET /system-switches` — every scope with a module switched off,
 * from the directory's record, with no walk of every scope's store. Staff and the service
 * token only: a tenant credential and a builder are each refused, each beside a staff read
 * of the same route that succeeds.
 */
describe('the fleet read route (#1674)', () => {
  const TENANT_SECRET = 'test-tenant-token-secret';
  const PUSH_SECRET = 'test-push-token-secret';
  const t = tenantId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SF');
  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  let asTenant: Record<string, string>;
  let asBuilder: Record<string, string>;
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;

  const switchRoute = (s: string) => `/tenants/${t}/scopes/${s}/system-grants`;
  const off = (s: string) =>
    app.request(switchRoute(s), { method: 'DELETE', headers: asStaff, body: JSON.stringify({ moduleId: TICK, reason: 'incident' }) });
  const on = (s: string) =>
    app.request(switchRoute(s), { method: 'POST', headers: asStaff, body: JSON.stringify({ moduleId: TICK, reason: 'resolved' }) });
  const fleet = async (query: string, headers: Record<string, string> = asStaff) =>
    app.request(`/system-switches?${query}`, { method: 'GET', headers });
  type Entry = { scopeId: string; position: string; operationId: string; vertical: string | null };
  const page = async (query: string) => {
    const res = await fleet(query);
    expect(res.status).toBe(200);
    return (await res.json()) as { entries: Entry[]; nextCursor: string | null };
  };

  const newScope = async () => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'tick-vertical' });
    await host.admin.activateScope(staff, t, s);
    return s;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-schedule-switch-fleet-'));
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
    await host.admin.createTenant(staff, { id: t, slug: 'acme-fleet', name: 'Acme' });
    await host.admin.grantEntitlement(staff, t, 'tick');
    const minted = await app.request('/tenant-tokens', {
      method: 'POST',
      headers: asStaff,
      body: JSON.stringify({ tenantId: t }),
    });
    expect(minted.status).toBe(201);
    asTenant = { [SERVICE_TOKEN_HEADER]: ((await minted.json()) as { token: string }).token, 'content-type': 'application/json' };
    const push = await mintPushToken(PUSH_SECRET, { actor: await pushActorFor(t), tenantId: t, tenantSlug: 'acme-fleet' });
    asBuilder = { [SERVICE_TOKEN_HEADER]: push, 'content-type': 'application/json' };
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists what is switched off by default, drops a restored scope from it, and `position=all` shows both', async () => {
    const a = await newScope();
    const b = await newScope();
    await off(a);
    await off(b);
    await on(b);
    const offOnly = await page(`tenantId=${t}`);
    expect(offOnly.entries.map((e) => [e.scopeId, e.position])).toEqual([[a, 'off']]);
    expect(offOnly.entries[0]).toMatchObject({ vertical: 'tick-vertical', moduleId: TICK, reason: 'incident', actor: staff });
    const all = await page(`tenantId=${t}&position=all`);
    expect(all.entries.map((e) => e.scopeId).sort()).toEqual([a, b].sort());
    expect((await page(`tenantId=${t}&position=on`)).entries.map((e) => e.scopeId)).toEqual([b]);
    expect((await page(`scopeId=${b}`)).entries).toEqual([]);
    expect((await page(`vertical=other-vertical&tenantId=${t}`)).entries).toEqual([]);
  });

  it('pages by operation id, and the last page says so', async () => {
    const tenantScopes = await page(`tenantId=${t}&position=all&limit=200`);
    const already = tenantScopes.entries.length;
    for (let i = 0; i < 3; i++) await off(await newScope());
    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const next: { entries: Entry[]; nextCursor: string | null } = await page(
        `tenantId=${t}&position=all&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      walked.push(...next.entries.map((e) => e.operationId));
      cursor = next.nextCursor;
      pages++;
    } while (cursor !== null && pages < 10);
    expect(walked).toHaveLength(already + 3);
    expect(new Set(walked).size).toBe(walked.length);
    expect([...walked].sort()).toEqual(walked);
  });

  it("REFUSES a tenant's credential — even naming its own tenant — with staff reading the same route as the positive twin", async () => {
    const s = await newScope();
    await off(s);
    expect((await fleet(`tenantId=${t}`, asTenant)).status).toBe(403);
    expect((await fleet('', asTenant)).status).toBe(403);
    const twin = await fleet(`tenantId=${t}`, asStaff);
    expect(twin.status).toBe(200);
    expect(((await twin.json()) as { entries: Entry[] }).entries.map((e) => e.scopeId)).toContain(s);
  });

  it('REFUSES a builder, with staff reading the same route as the positive twin', async () => {
    const s = await newScope();
    await off(s);
    expect((await fleet(`tenantId=${t}`, asBuilder)).status).toBe(403);
    expect((await fleet(`tenantId=${t}`, asStaff)).status).toBe(200);
  });

  it('a restore of a backup from before the switch is put back off by the directory record, in the same request', async () => {
    const s = await newScope();
    const before = await host.admin.exportScope(staff, t, scopeId.parse(s));
    await off(s);
    const restored = await app.request(`/tenants/${t}/scopes/${s}/restore`, {
      method: 'POST',
      headers: asStaff,
      body: JSON.stringify(before),
    });
    expect(restored.status).toBe(200);
    const r = await host.runDueSchedules(TICK, t, scopeId.parse(s));
    expect(r).toMatchObject({ fired: 0, switchedOff: true });
    const status = await app.request(switchRoute(s), { method: 'GET', headers: asStaff });
    expect(((await status.json()) as { schedules: string; recorded: string }[])[0]).toMatchObject({
      schedules: 'off',
      recorded: 'off',
    });
  });
});

/**
 * The repair route (`POST /tenants/:t/scopes/:s/provision`, #1674): a hosted reconcile runs
 * in the vertical's own deployment, whose seat recreates a wiped scope's system grants live
 * (#1659), and the control plane re-asserts the directory's OFF after it. The fake
 * deployment does exactly that seat: it grants `tick:run` back, which is what the real one
 * does to a scope that lost its marker, and nothing else.
 */
describe('the repair route re-asserts the switch after the deployment reconciles (#1674)', () => {
  const t = tenantId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  let dir: string;
  let host: SqliteScopeHost;
  let reconciles = 0;

  const reseatingDeployment = () =>
    ({
      reconcileInstance: async (input: { tenantId: string; scopeId: string }) => {
        reconciles++;
        await host.admin.grantToSystem(staff, {
          moduleId: TICK,
          permission: 'tick:run' as PermissionKey,
          node: { tenantId: t, scopeId: scopeId.parse(input.scopeId) },
          grantedBy: staff,
        });
        return { tenantId: input.tenantId, scopeId: input.scopeId, owner: ulid() };
      },
    }) as unknown as VerticalClient;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-schedule-switch-repair-'));
    host = new SqliteScopeHost({ dir });
    host.registerModule(tickModule);
    await host.admin.createTenant(staff, { id: t, slug: 'acme-repair', name: 'Acme' });
    await host.admin.grantEntitlement(staff, t, 'tick');
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a wiped scope that the deployment re-seats comes back OFF, and its twin with no record stays on', async () => {
    const app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { 'tick-vertical': reseatingDeployment() },
    });
    const scopeWithSwitch = async (switchedOff: boolean) => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'tick-vertical' });
      await host.admin.activateScope(staff, t, s);
      if (switchedOff) {
        await host.admin.revokeFromSystem(staff, { moduleId: TICK, node: { tenantId: t, scopeId: s }, reason: 'incident' });
      }
      // Wiped: the marker and the grants are gone; the directory's record is not.
      await host.restoreScope(staff, t, s, { tenantId: t, scopeId: s, capturedAt: new Date().toISOString(), tables: [] });
      return s;
    };
    const repair = (s: string) => app.request(`/tenants/${t}/scopes/${s}/provision`, { method: 'POST', headers: asStaff });

    const off = await scopeWithSwitch(true);
    const before = reconciles;
    expect((await repair(off)).status).toBe(200);
    expect(reconciles).toBe(before + 1);
    expect(await host.runDueSchedules(TICK, t, off)).toMatchObject({ fired: 0, switchedOff: true });

    const twin = await scopeWithSwitch(false);
    expect((await repair(twin)).status).toBe(200);
    expect(await host.runDueSchedules(TICK, t, twin)).toMatchObject({ fired: 1 });
  });
});
