import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { createControlPlaneApi, UNSAFE_devPlatformActorAuth } from '@substrat-run/control-plane-api';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import type { PromotionReview } from '../src/promotion-review.js';
import { classifyRefusal, planPermission, promoteWithCheckpoint, type Acks, type Checkpoint, type PromoteReviewWire } from '../web/src/lib/promote-review.js';

/**
 * `GET /api/deployments/:slug/promote-review` and the dialog's logic against the REAL gate
 * (#1677). Same harness as `deployments-role-gate.test.ts` — the worker driven the way a
 * request reaches it, the control plane behind the service binding the real
 * `createControlPlaneApi` over a SQLite host — except that nothing about the promote is
 * faked here: the gate that refuses is the adapter's own `promoteVersion`, so the refusal
 * text `classifyRefusal` reads is the text production throws, not a copy of it.
 */

const shared = vi.hoisted(() => ({ host: null as unknown }));

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('@substrat-run/adapter-cloudflare', () => ({
  defineScopeDO: () => class {},
  ControlPlaneDO: class {},
  CloudflareScopeHost: class {
    constructor() {
      const target = shared.host as object;
      return new Proxy(target, {
        get(t, key) {
          if (key === 'registerModule') return () => undefined;
          const v = Reflect.get(t, key) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
    }
  },
}));
vi.mock('@substrat-run/oidc-rp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@substrat-run/oidc-rp')>()),
  mountOidcRoutes: () => undefined,
  verifySession: async (_env: unknown, token: string | undefined) => (token ? { id: token } : null),
}));

const workerModule = '../src/worker.js';
const { default: app } = (await import(/* @vite-ignore */ workerModule)) as {
  default: { request(path: string, init: RequestInit, env: unknown): Response | Promise<Response> };
};

// Compile-time: what the worker answers is assignable to what the web reads. The two are
// declared apart (the bundles never import each other), and this is the line that fails when
// one side moves without the other.
export const REVIEW_WIRE_AGREES: (r: PromotionReview) => PromoteReviewWire = (r) => r;

const PROVIDER = 'authhero';
const staff = platformActorId.parse(ulid());
const SLUG = 'acme/hr';

const registryOf = (extra: string[] = []) => ({
  permissions: [
    { key: 'hr:read', description: 'Read people', declaredBy: ['hr'] },
    ...extra.map((key) => ({ key, description: `The ${key} permission`, declaredBy: ['hr'] })),
  ],
  roles: [{ key: 'admin', permissions: ['hr:read', ...extra], source: 'vertical' }],
  entityGrants: [],
});

describe('the promote review and the checkpoint against the real gate (#1677)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  let env: Record<string, unknown>;
  /** Set per test to make the plane misbehave on a path. */
  let sabotage: ((path: string) => Response | Promise<Response> | undefined) | null;

  const subs = { owner: 'sub-owner', viewer: 'sub-viewer' } as const;
  const v = { v1: ulid(), v2: ulid(), v3: ulid(), v4: ulid(), old: ulid(), s1: ulid(), s2: ulid(), noSql: ulid() };
  const INIT = { moduleId: 'hr', version: '0001-init', sql: 'CREATE TABLE person (id TEXT PRIMARY KEY);' };
  const ADD = { moduleId: 'hr', version: '0002-salary', sql: 'ALTER TABLE person ADD COLUMN salary TEXT;' };

  async function publish(
    id: string,
    version: string,
    digests: { p: string; m: string },
    registry: ReturnType<typeof registryOf> | null,
    // New-CLI shape by default: `[]` ships no SQL. `null` leaves the field off, as a version
    // pushed before migrations were carried.
    migrations: { moduleId: string; version: string; sql: string }[] | null = [],
  ) {
    await host.admin.publishVersion(staff, {
      id,
      verticalSlug: SLUG,
      version,
      manifestDigest: `manifest-${version}`,
      permissionDigest: digests.p,
      migrationDigest: digests.m,
      deploymentRef: null,
      ...(registry
        ? {
            manifestJson: JSON.stringify({
              version,
              entry: 'index.js',
              compatibilityDate: '2026-07-01',
              registry,
              digests: { manifest: `manifest-${version}`, permission: digests.p, migration: digests.m },
              ...(migrations ? { migrations } : {}),
            }),
          }
        : {}),
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-promote-review-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    sabotage = null;

    const owner = principalId.parse(ulid());
    await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'review', name: 'Review' });
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    const link = (sub: string, principal: typeof owner) =>
      host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: sub, principal, tenantId: tenant, scopeId: dashScope });
    await link(subs.owner, owner);
    const viewer = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: viewer, roleKey: 'viewer', node: { tenantId: tenant, scopeId: null } });
    await link(subs.viewer, viewer);

    await host.admin.registerVertical(staff, { slug: SLUG, name: 'HR', source: 'cli', ownerTenant: tenant });
    // v1 → v2 moves the permission digest only; v1 → v3 the migration digest only; v4 both.
    await publish(v.v1, '1.0.0', { p: 'perm-1', m: 'mig-1' }, registryOf());
    await publish(v.v2, '1.1.0', { p: 'perm-2', m: 'mig-1' }, registryOf(['hr:admin']));
    await publish(v.v3, '1.2.0', { p: 'perm-1', m: 'mig-3' }, registryOf());
    await publish(v.v4, '2.0.0', { p: 'perm-4', m: 'mig-4' }, registryOf(['hr:admin', 'hr:export']));
    await publish(v.old, '0.1.0', { p: 'perm-0', m: 'mig-0' }, null); // pushed before D-39: no registry
    // s1 → s2 adds one SQL migration and moves NO digest: what #1754 is about.
    await publish(v.s1, '3.0.0', { p: 'perm-1', m: 'mig-1' }, registryOf(), [INIT]);
    await publish(v.s2, '3.1.0', { p: 'perm-1', m: 'mig-1' }, registryOf(), [INIT, ADD]);
    // Same digests as v1, and no SQL carried (an older CLI, or over the cap): the gate sees nothing.
    await publish(v.noSql, '3.2.0', { p: 'perm-1', m: 'mig-1' }, registryOf(), null);

    const plane = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
    env = {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: 'test-session-secret',
      CP_SERVICE_TOKEN: 'service-token',
      CONTROL_PLANE_SVC: {
        fetch: async (url: string | URL | Request, init?: RequestInit) => {
          const u = new URL(String(url));
          const path = u.pathname.replace(/^\/api/, '') + u.search;
          if (path === '/tenant-tokens') return Response.json({ token: 'tenant-token' });
          const bad = sabotage?.(u.pathname.replace(/^\/api/, ''));
          if (bad) return bad;
          return plane.request(path, init);
        },
      },
    };
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (sub: string | null, path: string) =>
    app.request(path, { method: 'GET', headers: sub ? { cookie: `sb_session=${sub}` } : {} }, env);
  const reviewPath = (versionId: string, slug = SLUG) => `/api/deployments/${encodeURIComponent(slug)}/promote-review?versionId=${versionId}`;
  const promoteTo = (id: string, ack?: Acks) => host.admin.promoteVersion(staff, SLUG, 'prod', id, ack);
  const prod = async () => (await host.admin.listChannels(staff, SLUG)).find((c) => c.channel === 'prod')?.versionId ?? null;

  describe('the route', () => {
    it('answers the serving registry against the incoming one — to a viewer too, reads being open', async () => {
      await promoteTo(v.v1);
      const res = await get(subs.viewer, reviewPath(v.v2));
      expect(res.status).toBe(200);
      const body = (await res.json()) as PromoteReviewWire;
      expect(body.serving).toEqual({ versionId: v.v1 });
      expect(body.incoming).toEqual({ versionId: v.v2 });
      expect(body.servingRegistry!.permissions.map((p) => p.key)).toEqual(['hr:read']);
      expect(body.incomingRegistry!.permissions.map((p) => p.key)).toEqual(['hr:read', 'hr:admin']);
    });

    it('a first promotion has nothing serving, and nothing to diff', async () => {
      const body = (await (await get(subs.owner, reviewPath(v.v1))).json()) as PromoteReviewWire;
      expect(body).toEqual({
        serving: null,
        incoming: { versionId: v.v1 },
        servingRegistry: null,
        incomingRegistry: null,
        migrations: null,
        exportBreaks: null,
      });
    });

    it('a version pushed before registries were kept reads as null — the answer, not a failure', async () => {
      await promoteTo(v.v1);
      const body = (await (await get(subs.owner, reviewPath(v.old))).json()) as PromoteReviewWire;
      expect(body.incomingRegistry).toBeNull();
      expect(body.servingRegistry).not.toBeNull();
      expect(planPermission(body)).toEqual({ kind: 'unverifiable', why: 'incoming-has-no-registry' });
    });

    it('is refused without a session, without a version, and for a vertical the team does not own', async () => {
      expect((await get(null, reviewPath(v.v2))).status).toBe(401);
      expect((await get(subs.owner, `/api/deployments/${encodeURIComponent(SLUG)}/promote-review`)).status).toBe(400);
      await host.admin.registerVertical(staff, { slug: 'other/billing', name: 'Billing', source: 'cli', ownerTenant: tenantId.parse(ulid()) });
      expect((await get(subs.owner, reviewPath(v.v2, 'other/billing'))).status).toBe(404);
    });

    // The point of the route existing at all: the lenient reads the Permissions tab uses
    // would answer 200 with a null registry here, and null means "cannot diff".
    describe('a read that failed FAILS the route — it never degrades to a null registry', () => {
      it('the registry read answering 500', async () => {
        await promoteTo(v.v1);
        sabotage = (p) => (p.endsWith('/registry') ? Response.json({ error: 'boom' }, { status: 500 }) : undefined);
        const res = await get(subs.owner, reviewPath(v.v2));
        expect(res.status).toBe(500);
      });
      it('the registry read never reaching the plane', async () => {
        await promoteTo(v.v1);
        sabotage = (p) => {
          if (p.endsWith('/registry')) throw new Error('connection reset');
          return undefined;
        };
        const res = await get(subs.owner, reviewPath(v.v2));
        expect(res.status).toBe(502);
      });
      it('the registry read answering an empty body', async () => {
        await promoteTo(v.v1);
        sabotage = (p) => (p.endsWith('/registry') ? new Response('not json', { status: 200 }) : undefined);
        expect((await get(subs.owner, reviewPath(v.v2))).status).toBeGreaterThanOrEqual(500);
      });
      it('the migrations read answering 500', async () => {
        await promoteTo(v.v1);
        sabotage = (p) => (p.endsWith('/migrations') ? Response.json({ error: 'boom' }, { status: 500 }) : undefined);
        expect((await get(subs.owner, reviewPath(v.v2))).status).toBe(500);
      });
      it('the migrations read answering an empty body', async () => {
        await promoteTo(v.v1);
        sabotage = (p) => (p.endsWith('/migrations') ? new Response('not json', { status: 200 }) : undefined);
        expect((await get(subs.owner, reviewPath(v.v2))).status).toBeGreaterThanOrEqual(500);
      });
      it('the channel read failing — which would otherwise read as "nothing serves yet", a first promotion', async () => {
        await promoteTo(v.v1);
        sabotage = (p) => (p.endsWith('/channels') ? Response.json({ error: 'boom' }, { status: 500 }) : undefined);
        expect((await get(subs.owner, reviewPath(v.v2))).status).toBe(500);
      });
    });
  });

  describe('the gate’s own refusal is what the dialog reads', () => {
    it('permission: the adapter’s message classifies, with its digest pair', async () => {
      await promoteTo(v.v1);
      const e = await promoteTo(v.v2).then(
        () => null,
        (err: Error) => err,
      );
      expect(classifyRefusal(e!.message)).toEqual({ kind: 'permission', digests: 'perm-1 → perm-2' });
    });
    it('migrations: likewise', async () => {
      await promoteTo(v.v1);
      const e = await promoteTo(v.v3).then(
        () => null,
        (err: Error) => err,
      );
      expect(classifyRefusal(e!.message)).toEqual({ kind: 'migration', digests: 'mig-1 → mig-3' });
    });
  });

  describe('the checkpoint, end to end', () => {
    // As the dashboard's own `call` does: a non-2xx REJECTS, it is never handed on as a body.
    const review = async (id: string) => {
      const res = await get(subs.owner, reviewPath(id));
      if (!res.ok) throw new Error(`${res.status}`);
      return (await res.json()) as PromoteReviewWire;
    };
    /** The gate is the host's own; what it was sent is what a spy on it records. */
    const sentAcks: Array<Acks | undefined> = [];
    const drive = (id: string, ...answers: Array<Acks | null>) => {
      sentAcks.length = 0;
      const shown: Checkpoint[] = [];
      return {
        shown,
        run: () =>
          promoteWithCheckpoint({
            review: () => review(id),
            promote: (ack) => {
              sentAcks.push(ack);
              return promoteTo(id, ack);
            },
            ask: async (c) => {
              shown.push(c);
              return answers[shown.length - 1] ?? null;
            },
          }),
      };
    };

    it('no change → no dialog, and the same request as before', async () => {
      await promoteTo(v.v1);
      const d = drive(v.v1);
      expect(await d.run()).toBe('promoted');
      expect(d.shown).toEqual([]);
      expect(sentAcks).toEqual([undefined]);
    });

    it('permission-only → the diff, one tick, permissionChange alone; the channel moves', async () => {
      await promoteTo(v.v1);
      const d = drive(v.v2, { permissionChange: true, migrationChange: true });
      expect(await d.run()).toBe('promoted');
      expect(d.shown).toHaveLength(1);
      expect(d.shown[0]!.permission).toMatchObject({ kind: 'diff', diff: { addedKeys: ['hr:admin'] } });
      expect(sentAcks).toEqual([{ permissionChange: true }]);
      expect(await prod()).toBe(v.v2);
    });

    it('permission-only, not ticked → nothing promoted', async () => {
      await promoteTo(v.v1);
      expect(await drive(v.v2, {}).run()).toBe('cancelled');
      expect(await prod()).toBe(v.v1);
    });

    it('migration-only → learned from the gate, its own tick, migrationChange alone', async () => {
      await promoteTo(v.v1);
      const d = drive(v.v3, { migrationChange: true });
      expect(await d.run()).toBe('promoted');
      expect(d.shown).toHaveLength(1);
      expect(d.shown[0]!.permission).toBeNull();
      // v3 adds no SQL (its digest moved on a Durable-Object class): an empty diff, shown as one.
      expect(d.shown[0]!.migration).toEqual({
        digests: 'mig-1 → mig-3',
        sql: { baseline: 'version', added: [], changed: [], total: 0, truncated: false },
        enforced: true,
      });
      expect(sentAcks).toEqual([undefined, { migrationChange: true }]);
      expect(await prod()).toBe(v.v3);
    });

    it('both → two questions, each ticked on its own; declining the second promotes nothing', async () => {
      await promoteTo(v.v1);
      expect(await drive(v.v4, { permissionChange: true }, null).run()).toBe('cancelled');
      expect(await prod()).toBe(v.v1);
      expect(sentAcks.some((a) => a?.migrationChange)).toBe(false);

      const d = drive(v.v4, { permissionChange: true }, { migrationChange: true });
      expect(await d.run()).toBe('promoted');
      expect(sentAcks).toEqual([{ permissionChange: true }, { permissionChange: true, migrationChange: true }]);
      expect(await prod()).toBe(v.v4);
    });

    it('a version with no registry needs the tick, and the gate agrees it was needed', async () => {
      await promoteTo(v.v1);
      expect(await drive(v.old, null).run()).toBe('cancelled');
      expect(await prod()).toBe(v.v1);
      // Nothing carried, so both kinds are asked about up front: the SQL is "not available",
      // never "unchanged".
      const d = drive(v.old, { permissionChange: true, migrationChange: true });
      expect(await d.run()).toBe('promoted');
      expect(d.shown).toHaveLength(1);
      expect(d.shown[0]!.permission).toEqual({ kind: 'unverifiable', why: 'incoming-has-no-registry' });
      expect(d.shown[0]!.migration).toEqual({ digests: null, sql: null, enforced: false });
      expect(await prod()).toBe(v.old);
    });

    it('SQL-only → the migrations the gate cannot see are shown and asked for, migrationChange alone', async () => {
      await promoteTo(v.s1);
      // The gate itself would let this through with no acknowledgement at all (#1754) …
      const declined = drive(v.s2, {});
      expect(await declined.run()).toBe('cancelled');
      expect(declined.shown[0]!.migration).toMatchObject({ enforced: false, sql: { baseline: 'version', added: [ADD], changed: [] } });
      expect(sentAcks).toEqual([]);
      expect(await prod()).toBe(v.s1);

      // … so the dialog is what asks, and a tick is what promotes.
      const d = drive(v.s2, { migrationChange: true });
      expect(await d.run()).toBe('promoted');
      expect(sentAcks).toEqual([{ migrationChange: true }]);
      expect(await prod()).toBe(v.s2);
    });

    it('no SQL carried and no digest moved → still asked, as "not available"; the gate alone would not have', async () => {
      await promoteTo(v.v1);
      const declined = drive(v.noSql, {});
      expect(await declined.run()).toBe('cancelled');
      expect(declined.shown[0]!.migration).toEqual({ digests: null, sql: null, enforced: false });
      expect(sentAcks).toEqual([]);
      expect(await prod()).toBe(v.v1);

      const d = drive(v.noSql, { migrationChange: true });
      expect(await d.run()).toBe('promoted');
      expect(sentAcks).toEqual([{ migrationChange: true }]);
    });

    it('a review that could not be read blocks the promote, with the plane unreachable', async () => {
      await promoteTo(v.v1);
      sabotage = (p) => (p.endsWith('/registry') ? Response.json({ error: 'boom' }, { status: 500 }) : undefined);
      const d = drive(v.v2, { permissionChange: true });
      await expect(d.run()).rejects.toBeDefined();
      expect(sentAcks).toEqual([]);
      expect(d.shown).toEqual([]);
      expect(await prod()).toBe(v.v1);
    });
  });
});
