import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import {
  createControlPlaneApi,
  UNSAFE_devPlatformActorAuth,
  type ControlPlaneApiOptions,
} from '@substrat-run/control-plane-api';
import {
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type ScopeBackup,
  type ScopeDump,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { ControlPlaneError, TenantNarrowedControlPlane } from '../src/authority.js';
import {
  BoundScopeError,
  isRetireArmed,
  moveBoundScopes,
  readBoundScopes,
  retireBoundScopes,
} from '../src/bound-scopes.js';
import { MODULES, provisionDashboard } from '../src/index.js';
import * as web from '../web/src/lib/bound-scopes.js';

/**
 * A vertical's bound scopes: the list a refused delete was counting, and what a builder may
 * do about it (#1592).
 *
 * The plane here is REAL — `createControlPlaneApi` over a SQLite host, reached through the
 * dashboard's own tenant-narrowed authority — because every claim below is about what that
 * plane does with what the dashboard asks of it: the refusal's own sentence and count, the
 * tenant filter, reap's refusal to wipe a scope that is still serving. A fake plane agrees
 * with whoever wrote it. Only the rebind is intercepted (it needs a dispatch namespace this
 * host has none of), and what it is asked is recorded.
 */
describe('bound scopes — what a refused delete was counting (#1592)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const A = tenantId.parse(ulid());
  const B = tenantId.parse(ulid());

  /** Every rebind the dashboard asked the plane for, answered 200 unless `refuseRebind` says otherwise. */
  let rebinds: Array<{ scopeId: string; body: { vertical: string; ackMigrations?: boolean } }>;
  let refuseRebind: ((scopeId: string) => string | null) | null;
  let calls: string[];

  /** The kind of backup store a deployed plane holds: enough to satisfy `backup: true`. */
  const backups: NonNullable<ControlPlaneApiOptions['scopeBackups']> = {
    put: async ({ vertical, dump }: { vertical: string | null; dump: ScopeDump }): Promise<ScopeBackup> => ({
      tenantId: dump.tenantId,
      scopeId: dump.scopeId,
      vertical,
      capturedAt: dump.capturedAt,
      size: 1,
      tables: dump.tables.length,
    }),
    list: async () => [],
    get: async () => null,
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-bound-scopes-'));
    host = new SqliteScopeHost({ dir });
    rebinds = [];
    refuseRebind = null;
    calls = [];
    await host.admin.createTenant(staff, { id: A, slug: 'acme', name: 'Acme' });
    await host.admin.createTenant(staff, { id: B, slug: 'other', name: 'Other' });
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const api = () =>
    createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth(), scopeBackups: backups });

  /** A dashboard authority for one tenant, over the real plane. */
  function planeFor(tenant: TenantId): TenantNarrowedControlPlane {
    const plane = api();
    return new TenantNarrowedControlPlane({
      baseUrl: 'http://cp',
      actor: staff,
      credential: 'unused-by-the-dev-authenticator',
      tenantId: tenant,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = new URL(String(url));
        const path = u.pathname + u.search;
        calls.push(`${init?.method ?? 'GET'} ${path}`);
        const rebind = /\/scopes\/([^/]+)\/rebind-vertical$/.exec(u.pathname);
        if (rebind) {
          const body = JSON.parse(String(init?.body)) as { vertical: string; ackMigrations?: boolean };
          rebinds.push({ scopeId: rebind[1]!, body });
          const refusal = refuseRebind?.(rebind[1]!) ?? null;
          return refusal === null
            ? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
            : new Response(JSON.stringify({ error: refusal }), { status: 409, headers: { 'content-type': 'application/json' } });
        }
        return plane.request(path, init);
      }) as typeof globalThis.fetch,
    });
  }

  const vertical = (slug: string, owner: TenantId | null = A) =>
    host.admin.registerVertical(staff, { slug, name: slug, source: 'cli', ...(owner ? { ownerTenant: owner } : {}) });

  /** An install bound to `slug`, active unless told otherwise. `names` are hostnames it holds. */
  async function install(
    tenant: TenantId,
    slug: string,
    handle: string,
    opts: { names?: string[]; status?: 'active' | 'archived'; forkOf?: ScopeId } = {},
  ): Promise<ScopeId> {
    const id = scopeId.parse(ulid());
    await host.provisionScope(staff, {
      tenantId: tenant,
      scopeId: id,
      slug: handle,
      name: handle,
      vertical: slug,
      ...(opts.forkOf ? { forkedFrom: opts.forkOf, forkedAt: '2026-09-01T00:00:00.000Z' } : {}),
    });
    await host.admin.activateScope(staff, tenant, id);
    for (const [i, hostname] of (opts.names ?? []).entries()) {
      await host.admin.bindHostname(staff, { hostname, tenantId: tenant, scopeId: id, surface: 'app', region: null, canonical: i === 0 });
      await host.admin.setHostnameStatus(staff, hostname, 'active');
    }
    if (opts.status === 'archived') await host.admin.archiveScope(staff, tenant, id);
    return id;
  }

  const statusOf = async (tenant: TenantId, id: ScopeId) => (await host.admin.getScopeRecord(staff, tenant, id))?.status;

  /** The refusal's own sentence, from the real plane — what the count in the UI must equal. */
  async function refusalFor(tenant: TenantId, slug: string): Promise<string> {
    try {
      await planeFor(tenant).deleteVertical(slug);
    } catch (e) {
      if (e instanceof ControlPlaneError) return e.message;
      throw e;
    }
    throw new Error(`expected '${slug}' to refuse deletion`);
  }

  // -- the list ---------------------------------------------------------------

  it('lists exactly the scopes the delete refusal counts — and the count is the refusal’s', async () => {
    await vertical('acme/courses');
    const s1 = await install(A, 'acme/courses', 'hr', { names: ['hr-acme.global.substrat.run'] });
    const s2 = await install(A, 'acme/courses', 'sales', { names: ['sales.acme.se', 'sales-acme.global.substrat.run'] });
    const s3 = await install(A, 'acme/courses', 'ops');

    const sentence = await refusalFor(A, 'acme/courses');
    const counted = Number(/still backs (\d+) scope\(s\)/.exec(sentence)![1]);

    const view = await readBoundScopes(planeFor(A), 'acme/courses');
    expect(counted).toBe(3);
    expect(view.live).toBe(counted);
    expect(view.scopes.map((s) => s.id).sort()).toEqual([s1, s2, s3].sort());
    // Each row says which names go offline first — what a wipe has to name.
    expect(view.scopes.find((s) => s.id === s2)!.hostnames).toEqual(['sales-acme.global.substrat.run', 'sales.acme.se']);
    expect(view.scopes.find((s) => s.id === s3)!.hostnames).toEqual([]);
  });

  it('counts the archived half on its own, exactly as the second refusal does — and never a reaped tombstone', async () => {
    await vertical('acme/mixed');
    await install(A, 'acme/mixed', 'live-one');
    await install(A, 'acme/mixed', 'live-two');
    await install(A, 'acme/mixed', 'shelved', { status: 'archived' });
    const gone = await install(A, 'acme/mixed', 'gone', { status: 'archived' });
    await host.admin.reapScope(staff, A, gone);

    // While anything live remains, the refusal counts ONLY the live ones…
    const live = Number(/still backs (\d+) scope\(s\)/.exec(await refusalFor(A, 'acme/mixed'))![1]);
    const view = await readBoundScopes(planeFor(A), 'acme/mixed');
    expect(live).toBe(2);
    expect(view).toMatchObject({ live, archived: 1 });
    expect(view.scopes.map((s) => s.slug)).toEqual(['live-one', 'live-two', 'shelved']); // live first; `gone` is history

    // …and once they are gone it counts the archived one, which the same view reports.
    await host.admin.archiveScope(staff, A, view.scopes[0]!.id as ScopeId);
    await host.admin.archiveScope(staff, A, view.scopes[1]!.id as ScopeId);
    const archived = Number(/still backs (\d+) archived scope\(s\)/.exec(await refusalFor(A, 'acme/mixed'))![1]);
    expect(archived).toBe(3);
    expect(await readBoundScopes(planeFor(A), 'acme/mixed')).toMatchObject({ live: 0, archived });
  });

  it('a vertical backing nothing has an empty view — there is no section to render', async () => {
    await vertical('acme/quiet');
    expect(await readBoundScopes(planeFor(A), 'acme/quiet')).toEqual({ live: 0, archived: 0, scopes: [] });
  });

  it('marks a snapshot fork and an archived scope as not movable — only a live install can be rebound', async () => {
    await vertical('acme/pilot');
    const parent = await install(A, 'acme/pilot', 'main');
    const fork = await install(A, 'acme/pilot', 'copy', { forkOf: parent });
    const shelved = await install(A, 'acme/pilot', 'shelved', { status: 'archived' });
    const view = await readBoundScopes(planeFor(A), 'acme/pilot');
    const by = (id: ScopeId) => view.scopes.find((s) => s.id === id)!;
    expect([by(parent).movable, by(fork).movable, by(shelved).movable]).toEqual([true, false, false]);
    expect(by(fork).fork).toBe(true);
  });

  // -- tenant isolation -------------------------------------------------------

  it('a builder sees only their own tenant’s scopes — and the same path shows each tenant its own', async () => {
    // One vertical, installed by two tenants. The refusal counts both; each dashboard sees its own.
    await vertical('acme/shared');
    const a1 = await install(A, 'acme/shared', 'a-one');
    const a2 = await install(A, 'acme/shared', 'a-two');
    const b1 = await install(B, 'acme/shared', 'b-one');

    const asA = await readBoundScopes(planeFor(A), 'acme/shared');
    const asB = await readBoundScopes(planeFor(B), 'acme/shared');
    expect(asA.scopes.map((s) => s.id).sort()).toEqual([a1, a2].sort());
    expect(asB.scopes.map((s) => s.id)).toEqual([b1]);
    // The plane's own refusal is global (3) — the honest gap between it and a tenant's list.
    expect(await refusalFor(A, 'acme/shared')).toMatch(/still backs 3 scope\(s\)/);
  });

  it('acts on nothing outside the tenant’s own list: another tenant’s scope id is a 404 before any write', async () => {
    await vertical('acme/shared');
    const mine = await install(A, 'acme/shared', 'a-one', { names: ['a-one.global.substrat.run'] });
    const theirs = await install(B, 'acme/shared', 'b-one', { names: ['b-one.global.substrat.run'] });

    // Positive twin first: the same call, naming a scope that IS this tenant's, gets through.
    await expect(
      retireBoundScopes(planeFor(A), { vertical: 'acme/shared', scopeIds: [mine], confirm: '1' }),
    ).resolves.toMatchObject({ retired: [mine], failure: null });

    // Now name the other tenant's scope — with the right confirmation for one scope.
    calls.length = 0;
    await expect(
      retireBoundScopes(planeFor(A), { vertical: 'acme/shared', scopeIds: [theirs], confirm: '1' }),
    ).rejects.toMatchObject({ status: 404 });
    // …and mixed in with one of the tenant's own, nothing at all is retired.
    const own = await install(A, 'acme/shared', 'a-two');
    await expect(
      retireBoundScopes(planeFor(A), { vertical: 'acme/shared', scopeIds: [own, theirs], confirm: '2' }),
    ).rejects.toMatchObject({ status: 404 });

    expect(await statusOf(B, theirs)).toBe('active');
    expect(await statusOf(A, own)).toBe('active');
    expect(calls.filter((c) => !c.startsWith('GET'))).toEqual([]); // not one write reached the plane
    expect((await host.admin.listHostnames(staff, { scopeId: theirs })).map((h) => h.hostname)).toEqual(['b-one.global.substrat.run']);
  });

  // -- Retire: the typed confirmation -----------------------------------------

  describe('Retire is armed only by typing the count', () => {
    async function threeInstalls() {
      await vertical('acme/courses');
      const ids = [
        await install(A, 'acme/courses', 'hr', { names: ['hr-acme.global.substrat.run'] }),
        await install(A, 'acme/courses', 'sales', { names: ['sales-acme.global.substrat.run'] }),
        await install(A, 'acme/courses', 'ops'),
      ];
      return ids;
    }

    it('refuses without the typed count — and refuses BEFORE touching the plane at all', async () => {
      const ids = await threeInstalls();
      calls.length = 0;
      for (const confirm of ['', '  ', '2', '4', 'three', 'hr', 'yes', '3x']) {
        await expect(
          retireBoundScopes(planeFor(A), { vertical: 'acme/courses', scopeIds: ids, confirm }),
        ).rejects.toBeInstanceOf(BoundScopeError);
      }
      // Not a read, not a write: a wrong confirmation is decided from the request alone.
      expect(calls).toEqual([]);
      for (const id of ids) expect(await statusOf(A, id)).toBe('active');
      expect(await host.admin.listHostnames(staff, { tenantId: A })).toHaveLength(2);
    });

    it('retires once the count is typed — names released, archived, wiped — and the delete that was refused now goes through', async () => {
      const ids = await threeInstalls();
      expect(await refusalFor(A, 'acme/courses')).toMatch(/still backs 3 scope\(s\)/);

      const outcome = await retireBoundScopes(planeFor(A), { vertical: 'acme/courses', scopeIds: ids, confirm: ' 3 ' });

      expect(outcome).toEqual({ retired: expect.arrayContaining(ids), failure: null });
      for (const id of ids) expect(await statusOf(A, id)).toBe('reaped');
      expect(await host.admin.listHostnames(staff, { tenantId: A })).toEqual([]);
      // The whole point: the count the refusal named is now zero, so the vertical can go.
      await expect(planeFor(A).deleteVertical('acme/courses')).resolves.toMatchObject({ deleted: true });
    });

    it('counts distinct scopes — naming one twice is not how you reach the typed number', async () => {
      const [hr, sales] = await threeInstalls();
      await expect(
        retireBoundScopes(planeFor(A), { vertical: 'acme/courses', scopeIds: [hr!, hr!, sales!], confirm: '3' }),
      ).rejects.toMatchObject({ status: 400 });
      expect(await statusOf(A, hr!)).toBe('active');
    });

    it('says what to type when it refuses', async () => {
      const ids = await threeInstalls();
      await expect(
        retireBoundScopes(planeFor(A), { vertical: 'acme/courses', scopeIds: ids, confirm: '' }),
      ).rejects.toThrow(/type 3 to confirm retiring 3 scopes/);
    });

    it('stops at the first failure and leaves the rest serving', async () => {
      const ids = await threeInstalls();
      // A plane with no backup store answers reap 501 and leaves the scope intact — but by
      // then its names are released and it is archived. Carrying on would take the NEXT
      // scope offline into the same refusal.
      const noBackups = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
      const cp = new TenantNarrowedControlPlane({
        baseUrl: 'http://cp',
        actor: staff,
        credential: 'x',
        tenantId: A,
        fetch: (async (url: string | URL | Request, init?: RequestInit) => {
          const u = new URL(String(url));
          return noBackups.request(u.pathname + u.search, init);
        }) as typeof globalThis.fetch,
      });
      const outcome = await retireBoundScopes(cp, { vertical: 'acme/courses', scopeIds: ids, confirm: '3' });
      expect(outcome.retired).toEqual([]);
      expect(outcome.failure).toMatchObject({ scopeId: expect.any(String), message: expect.stringMatching(/backup/i) });
      // Exactly one scope was taken as far as archived; the other two never left `active`.
      const states = await Promise.all(ids.map((id) => statusOf(A, id)));
      expect(states.filter((s) => s === 'archived')).toHaveLength(1);
      expect(states.filter((s) => s === 'active')).toHaveLength(2);
    });

    it('tells the caller about each scope once it is gone — never one that failed, never before the reap', async () => {
      const ids = await threeInstalls();
      const told: Array<{ id: string; status: string | undefined }> = [];
      await retireBoundScopes(planeFor(A), { vertical: 'acme/courses', scopeIds: ids, confirm: '3' }, async (id) => {
        told.push({ id, status: await statusOf(A, id as ScopeId) });
      });
      // In the order asked, each already `reaped` when told: the dashboard closes its own
      // row for the app only after the storage is gone, so a failed reap never orphans a live one.
      expect(told).toEqual(ids.map((id) => ({ id, status: 'reaped' })));

      // The same run against a plane that cannot back up: nothing is told, nothing was retired.
      const more = await install(A, 'acme/courses', 'more');
      const noBackups = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
      const cp = new TenantNarrowedControlPlane({
        baseUrl: 'http://cp', actor: staff, credential: 'x', tenantId: A,
        fetch: (async (url: string | URL | Request, init?: RequestInit) => {
          const u = new URL(String(url));
          return noBackups.request(u.pathname + u.search, init);
        }) as typeof globalThis.fetch,
      });
      const heard: string[] = [];
      await retireBoundScopes(cp, { vertical: 'acme/courses', scopeIds: [more], confirm: '1' }, async (id) => void heard.push(id));
      expect(heard).toEqual([]);
    });

    it('deletes a snapshot fork outright rather than archiving it', async () => {
      await vertical('acme/pilot');
      const parent = await install(A, 'acme/pilot', 'main');
      const fork = await install(A, 'acme/pilot', 'copy', { forkOf: parent });
      const outcome = await retireBoundScopes(planeFor(A), { vertical: 'acme/pilot', scopeIds: [fork], confirm: '1' });
      expect(outcome.retired).toEqual([fork]);
      expect(await host.admin.getScopeRecord(staff, A, fork)).toBeUndefined();
      expect(await statusOf(A, parent)).toBe('active');
    });
  });

  // -- Move: the primary act --------------------------------------------------

  describe('Move rebinds onto another vertical the team owns', () => {
    it('rebinds each chosen install, carrying the acknowledgement only when it was given', async () => {
      await vertical('acme/courses');
      await vertical('acme/coaching');
      const [s1, s2] = [await install(A, 'acme/courses', 'hr'), await install(A, 'acme/courses', 'sales')];

      const outcome = await moveBoundScopes(planeFor(A), { vertical: 'acme/courses', scopeIds: [s1, s2], target: 'acme/coaching' });
      expect(outcome).toEqual({ moved: [s1, s2], refusal: null });
      expect(rebinds).toEqual([
        { scopeId: s1, body: { vertical: 'acme/coaching' } },
        { scopeId: s2, body: { vertical: 'acme/coaching' } },
      ]);

      rebinds.length = 0;
      await moveBoundScopes(planeFor(A), { vertical: 'acme/courses', scopeIds: [s1], target: 'acme/coaching', ackMigrations: true });
      expect(rebinds).toEqual([{ scopeId: s1, body: { vertical: 'acme/coaching', ackMigrations: true } }]);
    });

    it('will not move onto a vertical the team does not own — another team’s, or one that is not theirs by construction', async () => {
      await vertical('acme/courses');
      await vertical('other/desk', B);
      await vertical('platform-thing', null);
      const s1 = await install(A, 'acme/courses', 'hr');
      // The positive twin: an owned target is accepted through the same path.
      await vertical('acme/coaching');
      await expect(
        moveBoundScopes(planeFor(A), { vertical: 'acme/courses', scopeIds: [s1], target: 'acme/coaching' }),
      ).resolves.toMatchObject({ moved: [s1] });

      rebinds.length = 0;
      for (const target of ['other/desk', 'platform-thing', 'acme/nonexistent']) {
        await expect(
          moveBoundScopes(planeFor(A), { vertical: 'acme/courses', scopeIds: [s1], target }),
        ).rejects.toMatchObject({ status: 404 });
      }
      expect(rebinds).toEqual([]);
    });

    it('refuses the same vertical, a foreign scope, and a fork or archived scope — all before anything moves', async () => {
      await vertical('acme/courses');
      await vertical('acme/coaching');
      const live = await install(A, 'acme/courses', 'hr');
      const fork = await install(A, 'acme/courses', 'copy', { forkOf: live });
      const shelved = await install(A, 'acme/courses', 'shelved', { status: 'archived' });
      const foreign = await install(B, 'acme/courses', 'b-one');
      const move = (scopeIds: string[], target = 'acme/coaching') =>
        moveBoundScopes(planeFor(A), { vertical: 'acme/courses', scopeIds, target });

      await expect(move([live], 'acme/courses')).rejects.toMatchObject({ status: 400 });
      await expect(move([live, foreign])).rejects.toMatchObject({ status: 404 });
      await expect(move([live, fork])).rejects.toMatchObject({ status: 409 });
      await expect(move([live, shelved])).rejects.toMatchObject({ status: 409 });
      await expect(move([])).rejects.toMatchObject({ status: 400 });
      expect(rebinds).toEqual([]);
    });

    it('stops at the plane’s first refusal and hands its sentence back verbatim, with what did move', async () => {
      await vertical('acme/courses');
      await vertical('acme/coaching');
      const [s1, s2, s3] = [
        await install(A, 'acme/courses', 'one'),
        await install(A, 'acme/courses', 'two'),
        await install(A, 'acme/courses', 'three'),
      ];
      const digest = "migration surfaces differ across lineages ('acme/courses' aaa → 'acme/coaching' bbb) — read both migration diffs, then re-run with ackMigrations";
      // Attempted in the order asked, so the second is the one the plane refuses.
      const chosen = [s1, s2, s3];
      refuseRebind = (id) => (id === chosen[1] ? digest : null);

      const outcome = await moveBoundScopes(planeFor(A), { vertical: 'acme/courses', scopeIds: chosen, target: 'acme/coaching' });
      expect(outcome.refusal).toEqual({ scopeId: chosen[1]!, message: digest });
      expect(outcome.moved).toEqual([chosen[0]]);
      // The third was never attempted: the operator reads the refusal and re-runs the rest.
      expect(rebinds.map((r) => r.scopeId)).toEqual([chosen[0], chosen[1]]);
    });
  });

  // -- the seam ---------------------------------------------------------------

  it('the two new authority calls are pinned to the tenant and carry what the plane needs', async () => {
    const seen: Array<{ url: string; method: string; body: unknown }> = [];
    const cp = new TenantNarrowedControlPlane({
      baseUrl: 'https://cp/api',
      actor: staff,
      credential: 't',
      tenantId: A,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response('{}', { status: 200 });
      }) as typeof globalThis.fetch,
    });
    const S = scopeId.parse(ulid());
    await cp.reapScope(S);
    await cp.rebindScopeVertical(S, 'acme/coaching');
    await cp.rebindScopeVertical(S, 'acme/coaching', { ackMigrations: true });
    expect(seen).toEqual([
      // `backup: true` — a plane with no backup store must refuse, never wipe without a copy.
      { url: `https://cp/api/tenants/${A}/scopes/${S}/reap`, method: 'POST', body: { backup: true } },
      { url: `https://cp/api/tenants/${A}/scopes/${S}/rebind-vertical`, method: 'POST', body: { vertical: 'acme/coaching' } },
      { url: `https://cp/api/tenants/${A}/scopes/${S}/rebind-vertical`, method: 'POST', body: { vertical: 'acme/coaching', ackMigrations: true } },
    ]);
  });

  // -- who may act ------------------------------------------------------------

  it('a viewer can read the list but not act on it — the role gate is the dashboard:provision-app check', async () => {
    const owner = principalId.parse(ulid());
    for (const m of MODULES) host.registerModule(m);
    const node = await provisionDashboard(host, {
      tenantId: tenantId.parse(ulid()),
      scopeId: scopeId.parse(ulid()),
      owner,
      slug: 'roles',
      name: 'Roles',
    });
    const viewer = principalId.parse(ulid());
    const member = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: viewer, roleKey: 'viewer', node: { tenantId: node.tenantId, scopeId: null } });
    await host.admin.assignRole(staff, { principalId: member, roleKey: 'member', node: { tenantId: node.tenantId, scopeId: null } });

    const gate = async (p: typeof owner) =>
      (await host.getScope(p, node.tenantId, node.scopeId)).invoke('dashboard/authorize-scope-change', {});

    // The twin: the roles that manage installs pass through the same operation.
    await expect(gate(owner)).resolves.toEqual({ ok: true });
    await expect(gate(member)).resolves.toEqual({ ok: true });
    await expect(gate(viewer)).rejects.toThrow(/permission denied/i);
  });
});

// -- the browser's half ---------------------------------------------------------

describe('the browser helpers agree with the worker’s guard', () => {
  it('isRetireArmed is the same rule on both sides of the wire', () => {
    const cases: Array<[string, number]> = [
      ['3', 3], [' 3 ', 3], ['03', 3], ['3.0', 3], ['', 3], ['2', 3], ['4', 3], ['three', 3],
      ['0', 0], ['', 0], ['1', 1], ['10', 1], ['1', 10], ['10', 10],
    ];
    for (const [typed, count] of cases) {
      expect(web.isRetireArmed(typed, count), `${JSON.stringify(typed)} for ${count}`).toBe(isRetireArmed(typed, count));
    }
    expect(web.isRetireArmed('3', 3)).toBe(true);
    expect(web.isRetireArmed('2', 3)).toBe(false);
    // Nothing selected is never armed, whatever was typed.
    expect(web.isRetireArmed('0', 0)).toBe(false);
  });

  it('says different things about a refused Remove depending on whose installs are counted', () => {
    const refusal = "vertical 'acme/courses' still backs 3 scope(s) — delete or rebind them first";
    // None are ours: do not point at an empty list.
    expect(web.removalRefusalDetail(refusal, 0)).toMatch(/None of them are your team’s/);
    // Some are ours: point at the list, but never promise that clearing it is enough.
    const some = web.removalRefusalDetail(refusal, 2);
    expect(some).toMatch(/listed under Bound scopes/);
    expect(some).toMatch(/can also include other teams’ installs/);
    // Read failed: promise nothing about what the list holds.
    const unknown = web.removalRefusalDetail(refusal, null);
    expect(unknown).not.toMatch(/None of them/);
    expect(unknown).not.toMatch(/move or retire them/);
    // The registry's own sentence always leads, verbatim.
    for (const n of [0, 2, null]) expect(web.removalRefusalDetail(refusal, n).startsWith(refusal)).toBe(true);
  });

  it('renders a section only when something is bound — a vertical backing nothing gets none', () => {
    const row = { id: 'x', slug: 'hr', name: 'HR', status: 'active', fork: false, movable: true, verticalVersionId: null, createdAt: '2026-09-01T00:00:00Z', hostnames: [] };
    expect(web.hasBoundScopes(null)).toBe(false); // still loading: nothing to flash
    expect(web.hasBoundScopes({ live: 0, archived: 0, scopes: [] })).toBe(false);
    expect(web.hasBoundScopes({ live: 1, archived: 0, scopes: [row] })).toBe(true);
    expect(web.hasBoundScopes({ live: 0, archived: 1, scopes: [{ ...row, status: 'archived', movable: false }] })).toBe(true);
  });

  const dep = (slug: string, newest: string | null, prod = true) => ({
    slug,
    versions: newest === null ? [] : [{ createdAt: newest }],
    channels: prod ? [{ channel: 'prod' }] : [],
  });

  it('offers only the team’s other verticals that have a prod version, newest push first', () => {
    const old = dep('acme/courses', '2026-08-01T00:00:00Z');
    const renamed = dep('acme/coaching', '2026-09-10T00:00:00Z');
    const older = dep('acme/legacy', '2026-06-01T00:00:00Z');
    const unpromoted = dep('acme/draft', '2026-09-15T00:00:00Z', false);
    expect(web.moveTargets(old, [old, older, unpromoted, renamed]).map((d) => d.slug)).toEqual(['acme/coaching', 'acme/legacy']);
  });

  it('flags a rename only when another vertical of the team was pushed to more recently', () => {
    const old = dep('acme/courses', '2026-08-01T00:00:00Z');
    const renamed = dep('acme/coaching', '2026-09-10T00:00:00Z');
    expect(web.looksStrandedByRename(old, [old, renamed])).toBe(true);
    // The newest vertical is not stranded by anything…
    expect(web.looksStrandedByRename(renamed, [old, renamed])).toBe(false);
    // …and a team with a single vertical has nothing to have renamed to.
    expect(web.looksStrandedByRename(old, [old])).toBe(false);
    // A vertical with no versions at all while another has some: the classic stranded shape.
    expect(web.looksStrandedByRename(dep('acme/empty', null, false), [renamed])).toBe(true);
  });
});
