import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { migrationDigestOf, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import type { PromoteReviewWire } from '../web/src/lib/promote-review.js';
import { SERVICE_TOKEN, tenantPlane } from './tenant-plane.js';

/**
 * #3161, end to end through a route: a promote made in the dashboard delivers the promoted
 * version's delegations to the team auth-server the app signs in at. The plane is the REAL
 * `createControlPlaneApi` over a SQLite host, so the declaration is read off the `/flow` it
 * serves from the version's stored registry. Only the issuer's `/configure` (another scope's
 * config, which this host has no issuer module to take) and the app's directory record (a scope
 * this suite never provisions) are answered here.
 */

const shared = vi.hoisted(() => ({ host: null as unknown }));

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('@substrat-run/adapter-cloudflare', () => ({
  defineScopeDO: () => class {},
  defineScopeSweeperDO: () => class {},
  SCOPE_SWEEPER_NAME: 'scope-sweeper',
  ControlPlaneDO: class {},
  CloudflareScopeHost: class {
    constructor() {
      const target = shared.host as object;
      return new Proxy(target, {
        get(t, key) {
          if (key === 'registerModule' || key === 'registerExecutor') return () => undefined;
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
  default: { request(path: string, init: RequestInit, env: unknown, ctx?: unknown): Response | Promise<Response> };
};

const staff = platformActorId.parse(ulid());
const SLUG = 'acme/notes';
const ISSUER_HOST = 'auth-review.example.com';
const tenant = tenantId.parse(ulid());
const dashScope = scopeId.parse(ulid());
const notes = scopeId.parse(ulid());
const todo = scopeId.parse(ulid());
const authServer = scopeId.parse(ulid());
const v = { none: ulid(), delegating: ulid(), older: ulid() };

let dir: string;
let host: SqliteScopeHost;
let env: Record<string, unknown>;
let background: Promise<unknown>[];
/** What the issuer was told, as `[issuer scope, key, value]`. */
let configured: Array<[string, string, string]>;

const DECLARED = { actor: 'todo', permissions: ['notes:read'], channels: ['peer'] };
const KEYS = [{ key: 'notes:read', description: 'Read a note' }];

/**
 * A version as a push stores it. `delegations` absent is a CLI that predates the field: its
 * modules do not carry it, which `/flow` answers by leaving the field out.
 */
async function publish(id: string, digest: string, delegations?: (typeof DECLARED)[]) {
  const registry = {
    permissions: KEYS.map((k) => ({ ...k, declaredBy: ['notes'] })),
    roles: [{ key: 'member', permissions: ['notes:read'], source: 'vertical' }],
    entityGrants: [],
    ...(delegations?.length ? { delegations: delegations.map((d) => ({ ...d, declaredBy: ['notes'] })) } : {}),
  };
  const migrationDigest = await migrationDigestOf({ doClasses: [], migrations: [] });
  await host.admin.publishVersion(staff, {
    id,
    verticalSlug: SLUG,
    version: `1.0.${id.toLowerCase()}`,
    manifestDigest: `manifest-${id}`,
    permissionDigest: digest,
    migrationDigest,
    deploymentRef: null,
    manifestJson: JSON.stringify({
      version: `1.0.${id.toLowerCase()}`,
      entry: 'index.js',
      compatibilityDate: '2026-07-01',
      registry,
      modules: [{ id: 'notes', permissions: KEYS, ...(delegations ? { delegations } : {}) }],
      digests: { manifest: `manifest-${id}`, permission: digest, migration: migrationDigest },
      migrations: [],
    }),
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'substrat-delegations-route-'));
  host = new SqliteScopeHost({ dir });
  shared.host = host;
  for (const m of MODULES) host.registerModule(m);
  background = [];
  configured = [];

  const owner = principalId.parse(ulid());
  const node = await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'review', name: 'Review' });
  await host.admin.registerIdentityPool(staff, { provider: 'authhero', topology: 'central', tenantId: null });
  await host.admin.linkIdentity(staff, { provider: 'authhero', externalId: 'sub-owner', principal: owner, tenantId: tenant, scopeId: dashScope });
  // The team's auth-server, and two apps signing in at it: notes (the host) and todo (the actor).
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  for (const [appScopeId, verticalSlug, hostname] of [
    [authServer, 'auth-server', ISSUER_HOST],
    [notes, SLUG, undefined],
    [todo, 'todo', undefined],
  ] as const) {
    await dash.invoke('dashboard/provision-app', { appScopeId, verticalSlug, name: verticalSlug });
    await dash.invoke('dashboard/mark-app-active', { appScopeId, ...(hostname ? { hostname } : {}) });
    if (!hostname) {
      await dash.invoke('dashboard/set-app-auth', { appScopeId, config: { mode: 'oidc', issuer: `https://${ISSUER_HOST}`, clientId: `client-${verticalSlug}` } });
    }
  }

  await host.admin.registerVertical(staff, { slug: SLUG, name: 'Notes', source: 'cli', ownerTenant: tenant });
  await publish(v.none, 'perm-none', []);
  await publish(v.delegating, 'perm-delegating', [DECLARED]);
  await publish(v.older, 'perm-none');

  const plane = tenantPlane(host, staff);
  env = {
    SCOPE: {},
    CONTROL_PLANE: {},
    SESSION_SECRET: 'test-session-secret',
    CP_SERVICE_TOKEN: SERVICE_TOKEN,
    CONTROL_PLANE_SVC: {
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        const u = new URL(String(url));
        const path = u.pathname.replace(/^\/api/, '');
        const target = /^\/tenants\/[^/]+\/scopes\/([^/]+)(\/configure)?$/.exec(path);
        if (target?.[2]) {
          const { entries } = JSON.parse(String(init?.body)) as { entries: Array<{ key: string; value: string }> };
          for (const e of entries) configured.push([target[1]!, e.key, e.value]);
          return Response.json({});
        }
        // Each app follows prod: none is bound to a version of its own.
        if (target && (init?.method ?? 'GET') === 'GET' && target[1] !== dashScope) return Response.json({ verticalVersionId: null });
        return plane.request(path + u.search, init);
      },
    },
  };
});

afterEach(async () => {
  await Promise.allSettled(background);
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

const request = (method: string, path: string, body?: unknown) =>
  app.request(
    path,
    {
      method,
      headers: { cookie: 'sb_session=sub-owner', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
    { waitUntil: (p: Promise<unknown>) => void background.push(p), passThroughOnException: () => undefined },
  );

/** Promote through the dashboard's route, acknowledging the permission change it shows, then let the sync land. */
async function promote(versionId: string) {
  const reviewPath = `/api/teams/${tenant}/deployments/${encodeURIComponent(SLUG)}/promote-review?versionId=${versionId}`;
  const shown = (await (await request('GET', reviewPath)).json()) as PromoteReviewWire;
  const acknowledge = shown.serving ? { permissionChange: true, ...(shown.review ? { review: shown.review } : {}) } : undefined;
  const res = await request('POST', `/api/teams/${tenant}/deployments/${encodeURIComponent(SLUG)}/promote`, {
    channel: 'prod',
    versionId,
    ...(acknowledge ? { acknowledge } : {}),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  await Promise.all(background.splice(0));
}

const notesKey = `substrat:delegations:${notes}`;
const deliveredFor = (key: string) => configured.filter(([, k]) => k === key);

it('a promote delivers the version’s declared delegations to the issuer, revokes them on a version that declares none, and leaves them on one that cannot say', async () => {
  await promote(v.delegating);
  expect(deliveredFor(notesKey)).toEqual([[authServer, notesKey, JSON.stringify([{ actor: todo, permissions: ['notes:read'], channels: ['peer'] }])]]);

  // A version an older CLI pushed cannot say what it delegates: nothing is delivered for it, so
  // the grant the last version gave is not revoked by a guess.
  configured = [];
  await promote(v.older);
  expect(deliveredFor(notesKey)).toEqual([]);

  // A version that declares none (its modules carry `[]`) revokes it.
  await promote(v.none);
  expect(deliveredFor(notesKey)).toEqual([[authServer, notesKey, '']]);
});
