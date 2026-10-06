import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { mountPlatformSurface } from '@substrat-run/vertical-host';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
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
  VerticalClient,
  settleUnrecordedOutcomes,
  UNRECORDED_OUTCOME_LOG,
} from '../src/index.js';

/**
 * The owner hand-over over HTTP (#1665). The move itself runs in the vertical (its route and
 * its ordering have their own suite in vertical-host); what this pins is who may ask, and that
 * every attempt the platform lets through is on the admin log, intent first, naming who handed
 * what to whom.
 *
 * Every refusal is paired with its positive twin on the same route, and each also asserts the
 * vertical was NOT reached and no audit row was written. A 403 that had already moved the owner
 * would pass a status-only check.
 */
describe('the owner hand-over route (#1665)', () => {
  const TENANT_SECRET = 'test-tenant-token-secret';
  const PUSH_SECRET = 'test-push-token-secret';
  const t = tenantId.parse(ulid());
  const other = tenantId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const A = principalId.parse(ulid());
  const B = principalId.parse(ulid());
  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  let asTenant: Record<string, string>;
  let asBuilder: Record<string, string>;
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;

  /** What the vertical was asked, and what it answers next. */
  let asked: unknown[];
  let answer: () => Promise<unknown>;
  const fakeVertical = {
    transferOwner: async (input: unknown) => {
      asked.push(input);
      return answer();
    },
  } as unknown as VerticalClient;

  const route = (s: string, tenant: string = t) => `/tenants/${tenant}/scopes/${s}/owner-transfer`;
  const send = (path: string, headers: Record<string, string>, body: unknown = { from: A, to: B }) =>
    app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const newScope = async (vertical: string | null = 'desk-vertical') => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, ...(vertical ? { vertical } : {}) });
    await host.admin.activateScope(staff, t, s);
    return s;
  };
  /** The scope's hand-over rows as an operator reads them, oldest first. */
  const rows = async (s: string) => {
    const log = await app.request(`/admin-log?tenantId=${t}&scopeId=${s}&action=transferOwner`, { headers: asStaff });
    expect(log.status).toBe(200);
    return ((await log.json()) as { entries: { actor: string; after: Record<string, unknown> }[] }).entries.map((e) => ({
      actor: e.actor,
      ...e.after,
    }));
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-owner-transfer-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(TENANT_SECRET, serviceActor),
      authenticateBuilder: firstBuilderAuth(pushTokenBuilderAuth(PUSH_SECRET)),
      tenantTokenSecret: TENANT_SECRET,
      pushTokenSecret: PUSH_SECRET,
      verticals: { 'desk-vertical': fakeVertical },
    });
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    await host.admin.createTenant(staff, { id: other, slug: 'tenant-b', name: 'Tenant B' });
    const minted = await app.request('/tenant-tokens', { method: 'POST', headers: asStaff, body: JSON.stringify({ tenantId: t }) });
    expect(minted.status).toBe(201);
    asTenant = { [SERVICE_TOKEN_HEADER]: ((await minted.json()) as { token: string }).token, 'content-type': 'application/json' };
    const push = await mintPushToken(PUSH_SECRET, { actor: await pushActorFor(t), tenantId: t, tenantSlug: 'acme' });
    asBuilder = { [SERVICE_TOKEN_HEADER]: push, 'content-type': 'application/json' };
  });

  beforeEach(() => {
    asked = [];
    answer = async () => ({ scopeId: 'unused', from: A, owner: B, outcome: 'transferred', fromRevoked: true });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('staff hands the seat over; the vertical is asked once, and both rows name from, to and the actor', async () => {
    const s = await newScope();
    answer = async () => ({ scopeId: s, from: A, owner: B, outcome: 'transferred', fromRevoked: true });
    const res = await send(route(s), asStaff);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { operationId: string };
    expect(body).toEqual({ operationId: expect.any(String), scopeId: s, from: A, owner: B, outcome: 'transferred', fromRevoked: true });
    expect(asked).toEqual([{ tenantId: t, scopeId: s, from: A, to: B }]);
    const base = { actor: staff, operationId: body.operationId, from: A, to: B };
    expect(await rows(s)).toEqual([
      { ...base, phase: 'intent' },
      { ...base, phase: 'applied', outcome: 'transferred', fromRevoked: true },
    ]);
  });

  it("REFUSES the tenant's own credential — and the staff twin on the same scope goes through", async () => {
    const s = await newScope();
    const res = await send(route(s), asTenant);
    expect(res.status).toBe(403);
    // Refused at the credential's allowlist since #977 named the dashboard's routes one by
    // one; the handler's own staff-only check stays, behind it, for any other confined caller.
    expect(((await res.json()) as { error: string }).error).toMatch(/staff-only|forbidden/);
    expect(asked).toEqual([]);
    expect(await rows(s)).toEqual([]);
    expect((await send(route(s), asStaff)).status).toBe(200);
    expect(asked).toHaveLength(1);
  });

  it('REFUSES a builder — and the staff twin goes through', async () => {
    const s = await newScope();
    expect((await send(route(s), asBuilder)).status).toBe(403);
    expect(asked).toEqual([]);
    expect(await rows(s)).toEqual([]);
    expect((await send(route(s), asStaff)).status).toBe(200);
  });

  it('REFUSES an unauthenticated caller — and the staff twin goes through', async () => {
    const s = await newScope();
    expect((await send(route(s), { 'content-type': 'application/json' })).status).toBe(401);
    expect(asked).toEqual([]);
    expect((await send(route(s), asStaff)).status).toBe(200);
  });

  it("answers 404 for a scope addressed under another tenant's path, before the vertical is reached", async () => {
    const s = await newScope();
    expect((await send(route(s, other), asStaff)).status).toBe(404);
    expect(asked).toEqual([]);
    expect((await send(route(s), asStaff)).status).toBe(200);
  });

  it('refuses a malformed body: one principal on both sides, a missing side, anything extra', async () => {
    const s = await newScope();
    for (const body of [{ from: A, to: A }, { from: A }, { from: A, to: 'nope' }, { from: A, to: B, scopeId: ulid() }]) {
      expect((await send(route(s), asStaff, body)).status).toBe(400);
    }
    expect(asked).toEqual([]);
    expect(await rows(s)).toEqual([]);
  });

  it("relays the vertical's refusal (its 409 wrote nothing) and audits it as `refused`", async () => {
    const s = await newScope();
    answer = async () => {
      throw new ControlPlaneError(409, `scope ${s} has an unclaimed owner seat — claim it first, then hand it over`);
    };
    const res = await send(route(s), asStaff);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; operationId: string };
    expect(body.error).toMatch(/claim it first/);
    const base = { actor: staff, operationId: body.operationId, from: A, to: B };
    expect(await rows(s)).toEqual([
      { ...base, phase: 'intent' },
      { ...base, phase: 'refused', error: body.error },
    ]);
  });

  it('a failure part-way is audited `failed`, and the same request retried is audited `applied`', async () => {
    const s = await newScope();
    answer = async () => {
      throw new ControlPlaneError(500, 'injected failure at assign');
    };
    const failed = await send(route(s), asStaff);
    expect(failed.status).toBe(500);
    const first = ((await failed.json()) as { operationId: string }).operationId;
    answer = async () => ({ scopeId: s, from: A, owner: B, outcome: 'already', fromRevoked: true });
    const retry = await send(route(s), asStaff);
    expect(retry.status).toBe(200);
    const second = ((await retry.json()) as { operationId: string }).operationId;
    expect(second).not.toBe(first);
    expect((await rows(s)).map((r) => [r.operationId, r.phase])).toEqual([
      [first, 'intent'],
      [first, 'failed'],
      [second, 'intent'],
      [second, 'applied'],
    ]);
  });

  it("keeps only the first 300 characters of the vertical's error in the row; the caller gets it whole", async () => {
    const s = await newScope();
    const long = `stopped: ${'x'.repeat(1000)}`;
    answer = async () => {
      throw new ControlPlaneError(502, long);
    };
    const res = await send(route(s), asStaff);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe(long);
    const failed = (await rows(s)).find((r) => r.phase === 'failed') as { error: string };
    expect(failed.error).toBe(long.slice(0, 300));
  });

  it('a hand-over the log cannot take the intent row of never reaches the vertical', async () => {
    const s = await newScope();
    const original = host.admin.recordOwnerTransfer;
    host.admin.recordOwnerTransfer = async () => {
      throw new Error('admin log unavailable');
    };
    try {
      const res = await send(route(s), asStaff);
      expect(res.ok).toBe(false);
    } finally {
      host.admin.recordOwnerTransfer = original;
    }
    expect(asked).toEqual([]);
    // The twin: with the log back, the same request goes through.
    expect((await send(route(s), asStaff)).status).toBe(200);
    expect(asked).toHaveLength(1);
  });

  it('staff abandon an open hand-over: relayed as `abandon: true`, and every row is marked', async () => {
    const s = await newScope();
    answer = async () => ({ scopeId: s, from: A, owner: B, outcome: 'abandoned', fromRevoked: false });
    const res = await send(route(s), asStaff, { from: A, to: B, abandon: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { operationId: string; outcome: string };
    expect(body.outcome).toBe('abandoned');
    expect(asked).toEqual([{ tenantId: t, scopeId: s, from: A, to: B, abandon: true }]);
    const base = { actor: staff, operationId: body.operationId, from: A, to: B, abandon: true };
    expect(await rows(s)).toEqual([
      { ...base, phase: 'intent' },
      { ...base, phase: 'applied', outcome: 'abandoned', fromRevoked: false },
    ]);
    // The vertical's refusal (no such open hand-over) is a `refused` abandon row.
    answer = async () => {
      throw new ControlPlaneError(409, `scope ${s} has no open hand-over ${A} → ${B} to abandon`);
    };
    const refused = await send(route(s), asStaff, { from: A, to: B, abandon: true });
    expect(refused.status).toBe(409);
    expect((await rows(s)).slice(2).map((r) => [r.phase, r.abandon])).toEqual([
      ['intent', true],
      ['refused', true],
    ]);
  });

  it("REFUSES an abandon on the tenant's own credential and a builder's — and the staff twin goes through", async () => {
    const s = await newScope();
    const abandon = { from: A, to: B, abandon: true };
    expect((await send(route(s), asTenant, abandon)).status).toBe(403);
    expect((await send(route(s), asBuilder, abandon)).status).toBe(403);
    expect(asked).toEqual([]);
    expect(await rows(s)).toEqual([]);
    answer = async () => ({ scopeId: s, from: A, owner: B, outcome: 'abandoned', fromRevoked: false });
    expect((await send(route(s), asStaff, abandon)).status).toBe(200);
  });

  it('a hand-over whose OUTCOME row cannot be written says it completed, with its operationId', async () => {
    const s = await newScope();
    const original = host.admin.recordOwnerTransfer;
    host.admin.recordOwnerTransfer = async (actor, entry) => {
      if (entry.phase === 'applied') throw new Error('admin log unavailable');
      return original.call(host.admin, actor, entry);
    };
    let res: Response;
    try {
      res = await send(route(s), asStaff);
    } finally {
      host.admin.recordOwnerTransfer = original;
    }
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; operationId: string; owner: string };
    expect(body.error).toMatch(/hand-over completed, but its outcome could not be written/);
    expect(body.owner).toBe(B);
    expect(asked).toHaveLength(1);
    // The intent row stands, under the operation id the caller was told.
    expect((await rows(s)).map((r) => [r.operationId, r.phase])).toEqual([[body.operationId, 'intent']]);
  });

  it("a refusal whose `refused` row cannot be written still answers the vertical's 409 — logged, and closed by the sweep (#2064)", async () => {
    const s = await newScope();
    answer = async () => {
      throw new ControlPlaneError(409, 'claim it first');
    };
    const record = host.admin.recordOwnerTransfer;
    const unwritable = vi.spyOn(host.admin, 'recordOwnerTransfer').mockImplementation(async (actor, entry) => {
      if (entry.phase === 'refused') throw new Error('admin log unavailable');
      return record.call(host.admin, actor, entry);
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await send(route(s), asStaff);
    const calls = logged.mock.calls.slice();
    unwritable.mockRestore();
    logged.mockRestore();
    expect(res.status).toBe(409);
    const { operationId } = (await res.json()) as { operationId: string };
    expect(calls).toEqual([
      [UNRECORDED_OUTCOME_LOG, { flow: 'owner-transfer', operationId, phase: 'refused', auditError: 'admin log unavailable' }],
    ]);
    expect((await rows(s)).map((r) => r.phase)).toEqual(['intent']);
    // The scheduled pass closes the intent; the refusal itself is not recoverable from the log.
    const sweep = platformActorId.parse(ulid());
    const settled = await settleUnrecordedOutcomes({ admin: host.admin, actor: sweep, now: new Date(Date.now() + 2 * 3600_000) });
    expect(settled.settled.map((x) => x.operationId)).toContain(operationId);
    expect((await rows(s)).map((r) => [r.actor, r.phase])).toEqual([
      [staff, 'intent'],
      [sweep, 'unknown'],
    ]);
  });

  it('a scope no vertical serves has no owner seat to hand over — 501, and nothing is recorded', async () => {
    const s = await newScope(null);
    expect((await send(route(s), asStaff)).status).toBe(501);
    expect(asked).toEqual([]);
    expect(await rows(s)).toEqual([]);
  });
});

/**
 * The same route against the PRODUCER: a real `mountPlatformSurface` behind the
 * `VerticalClient`, so the body this client sends is the one the vertical's strict parse
 * accepts, and the vertical's refusal reaches the caller with its own status and message.
 */
describe('the owner hand-over, end to end through the vertical surface (#1665)', () => {
  const SECRET = 'platform-secret-for-test';
  const t = tenantId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const A = principalId.parse(ulid());
  const B = principalId.parse(ulid());
  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  /** The vertical's side: its owner of record, whether the seat is claimed, who holds the owner role. */
  const world = {
    record: A as string,
    claimed: true,
    members: new Set<string>([A, B]),
    seats: new Set<string>([A]),
    /** The open hand-over, as the directory keeps it. */
    open: null as null | { from: string; to: string },
  };

  beforeAll(async () => {
    const vertical = new Hono<{ Bindings: { PLATFORM_SECRET: string } }>();
    mountPlatformSurface(vertical, {
      platformSecret: (env) => env.PLATFORM_SECRET,
      hostFor: () =>
        ({
          assignScopeRole: async (_s: string, p: string) => void world.seats.add(p),
          revokeScopeRole: async (_s: string, p: string) => world.seats.delete(p),
          hasScopeRoleLocal: async (_t: string, _s: string, p: string) => world.members.has(p),
        }) as never,
      roles: [],
      ownerRoleKey: 'admin',
      transferOwner: async (_env, _ref, { from, to, toHoldsRole }) => {
        if (!world.claimed) return { outcome: 'refused', owner: world.record as never, reason: 'unclaimed' };
        if (world.open) {
          const same = world.open.from === from && world.open.to === to;
          if (!same) return { outcome: 'refused', owner: world.record as never, reason: 'in-flight', inFlight: world.open as never };
          if (!toHoldsRole) return { outcome: 'refused', owner: world.record as never, reason: 'wedged', inFlight: world.open as never };
          return { outcome: 'already', owner: to };
        }
        if (!toHoldsRole) return { outcome: 'refused', owner: world.record as never, reason: 'no-role' };
        if (world.record === to) return { outcome: 'refused', owner: to, reason: 'not-owner' };
        if (world.record !== from) return { outcome: 'refused', owner: world.record as never, reason: 'not-owner' };
        world.record = to;
        world.open = { from, to };
        return { outcome: 'transferred', owner: to };
      },
      completeOwnerTransfer: async () => {
        world.open = null;
        return true;
      },
      abandonOwnerTransfer: async (_env, _ref, { from, to, toHoldsRole }) => {
        if (world.open?.from !== from || world.open.to !== to) return 'not-open';
        if (toHoldsRole) return 'healthy';
        world.open = null;
        return 'abandoned';
      },
    });
    const client = new VerticalClient({
      fetch: ((url: string, init?: RequestInit) =>
        vertical.request(url, init, { PLATFORM_SECRET: SECRET })) as unknown as typeof fetch,
      platformSecret: SECRET,
    });
    dir = mkdtempSync(join(tmpdir(), 'cp-owner-transfer-e2e-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth(), verticals: { 'desk-vertical': client } });
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an unclaimed seat with the vertical's own 409, then hands a claimed one over", async () => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'desk-vertical' });
    await host.admin.activateScope(staff, t, s);
    const send = () =>
      app.request(`/tenants/${t}/scopes/${s}/owner-transfer`, { method: 'POST', headers: asStaff, body: JSON.stringify({ from: A, to: B }) });

    world.claimed = false;
    const refused = await send();
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/claim it first/);
    expect({ record: world.record, seats: [...world.seats] }).toEqual({ record: A, seats: [A] });

    world.claimed = true;
    const done = await send();
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({
      operationId: expect.any(String),
      scopeId: s,
      from: A,
      owner: B,
      outcome: 'transferred',
      fromRevoked: true,
    });
    expect({ record: world.record, seats: [...world.seats] }).toEqual({ record: B, seats: [B] });
  });

  it('a hand-over wedged by removing `to` is refused on resend with nothing seated, and staff abandon it', async () => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'desk-vertical' });
    await host.admin.activateScope(staff, t, s);
    const send = (body: unknown) =>
      app.request(`/tenants/${t}/scopes/${s}/owner-transfer`, { method: 'POST', headers: asStaff, body: JSON.stringify(body) });
    // Wedged: step 1 ran (the record names B, the hand-over is open) and then B was removed.
    Object.assign(world, { record: B, open: { from: A, to: B }, seats: new Set([A]) });
    // While B can still take it, an abandon is refused: resend it instead.
    const early = await send({ from: A, to: B, abandon: true });
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: string }).error).toMatch(/resend it instead/);
    world.members.delete(B);
    const resend = await send({ from: A, to: B });
    expect(resend.status).toBe(409);
    expect(((await resend.json()) as { error: string }).error).toMatch(/can no longer finish/);
    expect([...world.seats]).toEqual([A]); // nothing seated
    const abandoned = await send({ from: A, to: B, abandon: true });
    expect(abandoned.status).toBe(200);
    expect(await abandoned.json()).toMatchObject({ outcome: 'abandoned', owner: B, fromRevoked: false });
    expect(world.open).toBeNull();
    expect([...world.seats]).toEqual([A]); // and still nothing seated or revoked
  });
});
