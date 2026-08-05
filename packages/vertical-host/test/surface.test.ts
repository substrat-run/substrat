import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { PLATFORM_SECRET_HEADER } from '@substrat-run/kernel';
import { mountPlatformSurface, type VerticalScopeHost } from '../src/index.js';

const SECRET = 'sekret';
// Valid 26-char ULIDs (Crockford base32 — no I/L/O/U).
const SCOPE = '01JZ0000000000000000SCP001';
const TENANT = '01JZ0000000000000000TEN001';
const OWNER = '01JZ0000000000000000PRN001';

type Env = { PLATFORM_SECRET: string };

/** A host whose methods all record their call and return a benign value — except the ones a
 *  test overrides to throw, exercising the error envelope. */
function fakeHost(overrides: Partial<VerticalScopeHost> = {}): VerticalScopeHost & { calls: string[] } {
  const calls: string[] = [];
  const note = <T>(name: string, v: T) => {
    calls.push(name);
    return v;
  };
  const base: VerticalScopeHost = {
    provisionScopeLocal: async () => note('provisionScopeLocal', undefined),
    restoreScopeLocal: async () => note('restoreScopeLocal', { tables: 3 }),
    projectRolesLocal: async () => note('projectRolesLocal', undefined),
    exportScopeLocal: async () => note('exportScopeLocal', []),
    snapshotScopeLocal: async () => note('snapshotScopeLocal', { tables: 3 }),
    deleteScopeLocal: async () => note('deleteScopeLocal', undefined),
    migrationBookmarksLocal: async () => note('migrationBookmarksLocal', []),
    rewindScopeLocal: async () => note('rewindScopeLocal', { rewindingTo: 'bm' }),
    introspectScopeTables: async () => note('introspectScopeTables', []),
    introspectScopeTable: async () => note('introspectScopeTable', { rows: [] }),
    introspectScopeQuery: async () => note('introspectScopeQuery', { columns: [], rows: [] }) as never,
    listPlatformRequests: async () => note('listPlatformRequests', []),
    settlePlatformRequest: async () => note('settlePlatformRequest', undefined),
  };
  return Object.assign(base, overrides, { calls }) as VerticalScopeHost & { calls: string[] };
}

function appWith(
  host: VerticalScopeHost,
  deps: Partial<Parameters<typeof mountPlatformSurface<Env>>[1]> = {},
) {
  const app = new Hono<{ Bindings: Env }>();
  mountPlatformSurface<Env>(app, {
    platformSecret: (env) => env.PLATFORM_SECRET,
    hostFor: () => host,
    roles: [],
    ownerRoleKey: 'admin',
    ...deps,
  });
  return app;
}

const ENV: Env = { PLATFORM_SECRET: SECRET };
const authed = (extra: Record<string, string> = {}) => ({ [PLATFORM_SECRET_HEADER]: SECRET, ...extra });

describe('mountPlatformSurface — the platform-secret gate', () => {
  it('403s an /internal call with no platform secret', async () => {
    const res = await appWith(fakeHost()).request('/internal/export?scopeId=' + SCOPE, {}, ENV);
    expect(res.status).toBe(403);
  });

  it('403s an /internal call with the wrong secret', async () => {
    const res = await appWith(fakeHost()).request(
      '/internal/export?scopeId=' + SCOPE,
      { headers: { [PLATFORM_SECRET_HEADER]: 'nope' } },
      ENV,
    );
    expect(res.status).toBe(403);
  });

  it('admits a correctly-signed call', async () => {
    const res = await appWith(fakeHost()).request(
      '/internal/export?scopeId=' + SCOPE,
      { headers: authed() },
      ENV,
    );
    expect(res.status).toBe(200);
  });
});

describe('mountPlatformSurface — the error envelope (#510 regression)', () => {
  it('renders a thrown route as { error: <real message> }, never bare "Internal Server Error"', async () => {
    const host = fakeHost({
      restoreScopeLocal: async () => {
        throw new Error('FOREIGN KEY constraint failed');
      },
    });
    const res = await appWith(host).request(
      '/internal/restore',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ scopeId: SCOPE, tables: [] }),
      },
      ENV,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('FOREIGN KEY constraint failed');
    expect(await new Response(JSON.stringify(body)).text()).not.toBe('Internal Server Error');
  });

  it('maps an "invalid transition" throw to 409', async () => {
    const host = fakeHost({
      exportScopeLocal: async () => {
        throw new Error('invalid transition from draft to closed');
      },
    });
    const res = await appWith(host).request('/internal/export?scopeId=' + SCOPE, { headers: authed() }, ENV);
    expect(res.status).toBe(409);
  });

  it('maps a "permission denied" throw to 403', async () => {
    const host = fakeHost({
      exportScopeLocal: async () => {
        throw new Error('permission denied for scope');
      },
    });
    const res = await appWith(host).request(
      '/internal/export?scopeId=' + SCOPE,
      { headers: authed() },
      ENV,
    );
    expect(res.status).toBe(403);
  });

  it('honours a vertical-supplied mapError before the default', async () => {
    const host = fakeHost({
      exportScopeLocal: async () => {
        throw new Error('teapot');
      },
    });
    const res = await appWith(host, {
      mapError: (e) => (e instanceof Error && e.message === 'teapot' ? { status: 418, message: 'short and stout' } : undefined),
    }).request('/internal/export?scopeId=' + SCOPE, { headers: authed() }, ENV);
    expect(res.status).toBe(418);
    expect(((await res.json()) as { error: string }).error).toBe('short and stout');
  });
});

describe('mountPlatformSurface — the full route set is mounted', () => {
  const cases: [string, RequestInit][] = [
    ['/internal/export?scopeId=' + SCOPE, { headers: authed() }],
    ['/internal/bookmarks?scopeId=' + SCOPE, { headers: authed() }],
    ['/internal/tables?scopeId=' + SCOPE, { headers: authed() }],
    ['/internal/tables/some_table?scopeId=' + SCOPE, { headers: authed() }],
    ['/internal/platform-requests?tenantId=' + TENANT + '&scopeId=' + SCOPE, { headers: authed() }],
  ];
  it.each(cases)('GET %s is served (not 404)', async (path, init) => {
    const res = await appWith(fakeHost()).request(path, init, ENV);
    expect(res.status).not.toBe(404);
    expect(res.status).toBeLessThan(500);
  });

  it('restore re-projects roles when a tenantId is present', async () => {
    const host = fakeHost();
    await appWith(host).request(
      '/internal/restore',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE, tables: [] }),
      },
      ENV,
    );
    expect(host.calls).toContain('restoreScopeLocal');
    expect(host.calls).toContain('projectRolesLocal');
  });

  it('restore skips the role re-projection when no tenantId is given', async () => {
    const host = fakeHost();
    await appWith(host).request(
      '/internal/restore',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ scopeId: SCOPE, tables: [] }),
      },
      ENV,
    );
    expect(host.calls).toContain('restoreScopeLocal');
    expect(host.calls).not.toContain('projectRolesLocal');
  });
});

describe('mountPlatformSurface — flavored routes and their hooks', () => {
  it('provision runs the host then the onProvision hook, 201', async () => {
    const host = fakeHost();
    let hooked: string | null = null;
    const res = await appWith(host, {
      onProvision: async (_env, b) => {
        hooked = b.owner;
      },
    }).request(
      '/internal/provision',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE, owner: OWNER }),
      },
      ENV,
    );
    expect(res.status).toBe(201);
    expect(host.calls).toContain('provisionScopeLocal');
    expect(hooked).toBe(OWNER);
  });

  it('reconcile 501s when no resolveOwner is supplied', async () => {
    const res = await appWith(fakeHost()).request(
      '/internal/reconcile',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE }),
      },
      ENV,
    );
    expect(res.status).toBe(501);
  });

  it('reconcile 409s when the owner-of-record is missing', async () => {
    const res = await appWith(fakeHost(), { resolveOwner: async () => null }).request(
      '/internal/reconcile',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE }),
      },
      ENV,
    );
    expect(res.status).toBe(409);
  });

  it('reconcile re-provisions with the resolved owner', async () => {
    const host = fakeHost();
    const res = await appWith(host, { resolveOwner: async () => OWNER as never }).request(
      '/internal/reconcile',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(host.calls).toContain('provisionScopeLocal');
  });

  it('delete-scope runs the host then the onDeleteScope hook', async () => {
    const host = fakeHost();
    let forgotten: string | null = null;
    const res = await appWith(host, {
      onDeleteScope: async (_env, s) => {
        forgotten = s;
      },
    }).request(
      '/internal/delete-scope',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ scopeId: SCOPE }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(host.calls).toContain('deleteScopeLocal');
    expect(forgotten).toBe(SCOPE);
  });

  it('configure 501s when no onConfigure is supplied', async () => {
    const res = await appWith(fakeHost()).request(
      '/internal/configure',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE, entries: [{ key: 'a', value: 'b' }] }),
      },
      ENV,
    );
    expect(res.status).toBe(501);
  });

  it('configure runs the onConfigure hook when supplied', async () => {
    let got: number | null = null;
    const res = await appWith(fakeHost(), {
      onConfigure: async (_env, b) => {
        got = b.entries.length;
      },
    }).request(
      '/internal/configure',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE, entries: [{ key: 'a', value: 'b' }] }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(got).toBe(1);
  });
});
