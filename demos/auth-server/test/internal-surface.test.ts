import { describe, it, expect, beforeEach } from 'vitest';
import { ulid } from '@substrat-run/kernel';
import app, { type Env } from '../src/routes.js';
import type { AuthServerStub, ConfigEntry, InstanceMeta } from '../src/do-contract.js';

/**
 * The platform + routing surface of the worker app (`src/routes.ts`), driven in node with a
 * fake `AUTH` namespace. This is the layer the 2026-07-25 incident lived in: a platform
 * `/internal/provision` call fell through to the SPA catch-all, returned 200 text/html,
 * and surfaced in the dashboard as "Provisioning failed — internal error". Everything
 * here pins the contract the control plane and router rely on:
 *
 *   - `/internal/*` ALWAYS answers JSON — the implemented verbs (provision, configure,
 *     tables, export, delete-scope) work, everything else is an honest 501, and nothing
 *     reaches the SPA fallback.
 *   - Provisioning is platform-secret gated and fails closed when unconfigured.
 *   - The issuer DO is per-scope behind the router, the fixed standalone name without
 *     one, and a present-but-wrong router assertion is a 400, never a fall-through.
 */

const PLATFORM_SECRET = 'test-platform-secret';
const ROUTER_SECRET = 'test-router-secret';

/** A fake AUTH namespace: `idFromName` is identity, `get` hands out recording stubs. */
function fakeAuth() {
  const provisioned: Array<{ doName: string; meta: InstanceMeta; config?: ConfigEntry[] }> = [];
  const configured: Array<{ doName: string; entries: ConfigEntry[] }> = [];
  const introspected: Array<{ doName: string; verb: string }> = [];
  const exported: string[] = [];
  const destroyed: string[] = [];
  const touched: string[] = [];
  /** The paths the worker forwarded to the DO's `fetch` (the `/__*` control surface). */
  const forwarded: string[] = [];
  const namespace = {
    idFromName: (name: string) => name,
    get(id: unknown): AuthServerStub {
      const doName = id as string;
      touched.push(doName);
      return {
        fetch: async (request: Request) => {
          forwarded.push(new URL(request.url).pathname);
          return Response.json({ ok: true, doName });
        },
        issuerState: async () => ({ needsSetup: true, signupEnabled: false }),
        setupFirstAdmin: async () => ({ id: 'user-1' }),
        provisionInstance: async (meta, config) => {
          provisioned.push({ doName, meta, ...(config ? { config } : {}) });
        },
        setInstanceConfig: async (entries) => {
          configured.push({ doName, entries });
        },
        introspectTables: async () => {
          introspected.push({ doName, verb: 'tables' });
          return [{ name: 'user', rowCount: 1, system: false }];
        },
        introspectTable: async (table, limit, offset) => {
          introspected.push({ doName, verb: `table:${table}` });
          if (table === 'no_such_table') throw new Error(`unknown table '${table}'`);
          return { table, columns: ['id'], rows: [['u1']], rowCount: 1, limit, offset };
        },
        exportDump: async () => {
          exported.push(doName);
          return [{ name: 'user', ddl: 'CREATE TABLE user (id TEXT)', columns: ['id'], rows: [['u1']] }];
        },
        destroyStorage: async () => {
          destroyed.push(doName);
        },
      };
    },
  };
  return { namespace, provisioned, configured, introspected, exported, destroyed, touched, forwarded };
}

let auth: ReturnType<typeof fakeAuth>;
let env: Env;

beforeEach(() => {
  auth = fakeAuth();
  env = { AUTH: auth.namespace, PLATFORM_SECRET, ROUTER_SECRET };
});

const provisionBody = () => ({
  tenantId: ulid(),
  scopeId: ulid(),
  owner: ulid(),
  slug: 'acme-auth',
  name: 'Acme Auth',
});

function provision(body: unknown, secret?: string): Promise<Response> {
  return Promise.resolve(app.request(
    '/internal/provision',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { 'x-substrat-platform': secret } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  ));
}

describe('/internal/provision (K-31)', () => {
  it('provisions the SCOPE-NAMED issuer DO and echoes the instance', async () => {
    const body = provisionBody();
    const res = await provision(body, PLATFORM_SECRET);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ tenantId: body.tenantId, scopeId: body.scopeId, owner: body.owner });
    expect(auth.provisioned).toEqual([
      { doName: body.scopeId, meta: { tenantId: body.tenantId, scopeId: body.scopeId, slug: body.slug, name: body.name } },
    ]);
  });

  it('is idempotent — a re-run converges instead of erroring', async () => {
    const body = provisionBody();
    expect((await provision(body, PLATFORM_SECRET)).status).toBe(201);
    expect((await provision(body, PLATFORM_SECRET)).status).toBe(201);
    expect(auth.provisioned).toHaveLength(2);
    expect(auth.provisioned[0]).toEqual(auth.provisioned[1]);
  });

  it('refuses a call without the platform secret', async () => {
    const res = await provision(provisionBody());
    expect(res.status).toBe(403);
    expect(auth.provisioned).toHaveLength(0);
  });

  it('fails closed when the deployment has no platform secret configured', async () => {
    delete env.PLATFORM_SECRET;
    const res = await provision(provisionBody(), PLATFORM_SECRET);
    expect(res.status).toBe(403);
    expect(auth.provisioned).toHaveLength(0);
  });

  it('rejects a malformed body as a 400, before touching any DO', async () => {
    const res = await provision({ scopeId: 'not-a-ulid' }, PLATFORM_SECRET);
    expect(res.status).toBe(400);
    expect(auth.provisioned).toHaveLength(0);
  });

  it('carries provision-time config to the DO, so an instance arrives configured', async () => {
    const body = { ...provisionBody(), config: { ADMIN_EMAIL: 'root@acme.test', ADMIN_PASSWORD: 'super-secret-1' } };
    const res = await provision(body, PLATFORM_SECRET);
    expect(res.status).toBe(201);
    expect(auth.provisioned[0]?.config).toEqual([
      { key: 'ADMIN_EMAIL', value: 'root@acme.test' },
      { key: 'ADMIN_PASSWORD', value: 'super-secret-1' },
    ]);
  });
});

describe('/internal/configure (vertical-auth-detach.md §2.2)', () => {
  const configure = (body: unknown, secret?: string) =>
    Promise.resolve(app.request(
      '/internal/configure',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(secret ? { 'x-substrat-platform': secret } : {}),
        },
        body: JSON.stringify(body),
      },
      env,
    ));

  it('upserts entries into the SCOPE-NAMED issuer DO', async () => {
    const scope = ulid();
    const entries = [{ key: 'EMAIL_FROM', value: 'no-reply@acme.test' }];
    const res = await configure({ scopeId: scope, entries }, PLATFORM_SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: 1 });
    expect(auth.configured).toEqual([{ doName: scope, entries }]);
  });

  it('refuses a call without the platform secret', async () => {
    const res = await configure({ scopeId: ulid(), entries: [{ key: 'A', value: '1' }] });
    expect(res.status).toBe(403);
    expect(auth.configured).toHaveLength(0);
  });

  it('rejects empty entries as a 400 — a delivery with nothing to deliver is a caller bug', async () => {
    const res = await configure({ scopeId: ulid(), entries: [] }, PLATFORM_SECRET);
    expect(res.status).toBe(400);
    expect(auth.configured).toHaveLength(0);
  });
});

describe('/internal/tables (§5.4 introspection — the dashboard Data tab)', () => {
  const get = (path: string, secret?: string) =>
    Promise.resolve(app.request(path, { headers: secret ? { 'x-substrat-platform': secret } : {} }, env));

  it('lists the SCOPE-NAMED issuer DO’s tables', async () => {
    const scope = ulid();
    const res = await get(`/internal/tables?scopeId=${scope}`, PLATFORM_SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ name: 'user', rowCount: 1, system: false }]);
    expect(auth.introspected).toEqual([{ doName: scope, verb: 'tables' }]);
  });

  it('reads a bounded page of one table', async () => {
    const scope = ulid();
    const res = await get(`/internal/tables/user?scopeId=${scope}&limit=5&offset=0`, PLATFORM_SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ table: 'user', columns: ['id'], rows: [['u1']], rowCount: 1, limit: 5, offset: 0 });
    expect(auth.introspected).toEqual([{ doName: scope, verb: 'table:user' }]);
  });

  it('answers 404 for a table outside the live schema', async () => {
    const res = await get(`/internal/tables/no_such_table?scopeId=${ulid()}`, PLATFORM_SECRET);
    expect(res.status).toBe(404);
  });

  it('refuses a call without the platform secret, before touching any DO', async () => {
    expect((await get(`/internal/tables?scopeId=${ulid()}`)).status).toBe(403);
    expect((await get(`/internal/tables/user?scopeId=${ulid()}`)).status).toBe(403);
    expect(auth.introspected).toHaveLength(0);
  });

  it('rejects a malformed scope id as a 400', async () => {
    expect((await get('/internal/tables?scopeId=not-a-ulid', PLATFORM_SECRET)).status).toBe(400);
  });
});

describe('/internal/export (#590 — the full dump behind backed-up reap and carried rebind)', () => {
  const get = (path: string, secret?: string) =>
    Promise.resolve(app.request(path, { headers: secret ? { 'x-substrat-platform': secret } : {} }, env));

  it('dumps the SCOPE-NAMED issuer DO in full', async () => {
    const scope = ulid();
    const res = await get(`/internal/export?scopeId=${scope}`, PLATFORM_SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { name: 'user', ddl: 'CREATE TABLE user (id TEXT)', columns: ['id'], rows: [['u1']] },
    ]);
    expect(auth.exported).toEqual([scope]);
  });

  it('refuses a call without the platform secret, before touching any DO', async () => {
    const res = await get(`/internal/export?scopeId=${ulid()}`);
    expect(res.status).toBe(403);
    expect(auth.exported).toHaveLength(0);
  });

  it('rejects a malformed scope id as a 400', async () => {
    expect((await get('/internal/export?scopeId=not-a-ulid', PLATFORM_SECRET)).status).toBe(400);
    expect(auth.exported).toHaveLength(0);
  });
});

describe('/internal/delete-scope (#590 — the wipe half of a reap or carried rebind)', () => {
  const del = (body: unknown, secret?: string) =>
    Promise.resolve(app.request(
      '/internal/delete-scope',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(secret ? { 'x-substrat-platform': secret } : {}),
        },
        body: JSON.stringify(body),
      },
      env,
    ));

  it('destroys the SCOPE-NAMED issuer DO and echoes what it deleted', async () => {
    const scope = ulid();
    const res = await del({ scopeId: scope }, PLATFORM_SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: scope });
    expect(auth.destroyed).toEqual([scope]);
  });

  it('refuses a call without the platform secret, before touching any DO', async () => {
    const res = await del({ scopeId: ulid() });
    expect(res.status).toBe(403);
    expect(auth.destroyed).toHaveLength(0);
  });

  it('rejects a malformed scope id as a 400 — a wipe must never guess its target', async () => {
    expect((await del({ scopeId: 'not-a-ulid' }, PLATFORM_SECRET)).status).toBe(400);
    expect((await del({}, PLATFORM_SECRET)).status).toBe(400);
    expect(auth.destroyed).toHaveLength(0);
  });
});

describe('the /internal/* surface never reaches the SPA', () => {
  // The incident: an unknown /internal/* path served the SPA's index.html with 200, the
  // platform's JSON parse threw, and the dashboard showed the generic "internal error".
  it.each([
    ['GET', '/internal/bookmarks?scopeId=01JZ0000000000000000000000'],
    ['POST', '/internal/snapshot'],
    ['POST', '/internal/restore'],
    ['POST', '/internal/rewind'],
  ])('%s %s is a JSON 501, not the SPA fallback', async (method, path) => {
    const res = await app.request(path, { method, headers: { 'x-substrat-platform': PLATFORM_SECRET } }, env);
    expect(res.status).toBe(501);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('auth-server does not implement');
  });
});

describe('the issuer’s own admin API (/api/admin)', () => {
  it('forwards to the issuer DO under /__admin, never the SPA catch-all', async () => {
    const res = await app.request('/api/admin/clients', {}, env);
    expect(res.status).toBe(200);
    // The DO fake echoes what it was asked for. A fall-through to the inlined SPA would be
    // 200 text/html — the 2026-07-25 shape, where a JSON caller got a rendered page.
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toMatchObject({ ok: true });
    expect(auth.forwarded).toEqual(['/__admin/clients']);
  });

  it('reaches the routed scope’s issuer, not the standalone one', async () => {
    const scope = ulid();
    const res = await app.request(
      '/api/admin/settings',
      {
        method: 'PATCH',
        headers: {
          'x-substrat-tenant': ulid(),
          'x-substrat-scope': scope,
          'x-substrat-router': ROUTER_SECRET,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ allowSignup: true }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(auth.touched).toEqual([scope]);
    expect(auth.forwarded).toEqual(['/__admin/settings']);
  });
});

describe('issuer addressing (router assertion → DO name)', () => {
  it('routes an asserted request to the SCOPE-NAMED issuer', async () => {
    const scope = ulid();
    const res = await app.request(
      '/api/setup-state',
      { headers: { 'x-substrat-tenant': ulid(), 'x-substrat-scope': scope, 'x-substrat-router': ROUTER_SECRET } },
      env,
    );
    expect(res.status).toBe(200);
    expect(auth.touched).toEqual([scope]);
  });

  it('routes an unasserted request to the fixed standalone issuer', async () => {
    const res = await app.request('/api/setup-state', {}, env);
    expect(res.status).toBe(200);
    expect(auth.touched).toEqual(['auth-server']);
  });

  it('ignores scope headers entirely when no router secret is configured (standalone)', async () => {
    // A standalone deploy has a public route, so an unsigned x-substrat-scope header is
    // attacker-reachable; honoring it would let a stranger bootstrap a phantom issuer
    // under the real hostname.
    delete env.ROUTER_SECRET;
    const res = await app.request(
      '/api/setup-state',
      { headers: { 'x-substrat-tenant': ulid(), 'x-substrat-scope': ulid() } },
      env,
    );
    expect(res.status).toBe(200);
    expect(auth.touched).toEqual(['auth-server']);
  });

  it('refuses an assertion with a wrong router secret — 400, never a fall-through', async () => {
    const res = await app.request(
      '/api/setup-state',
      { headers: { 'x-substrat-tenant': ulid(), 'x-substrat-scope': ulid(), 'x-substrat-router': 'wrong' } },
      env,
    );
    expect(res.status).toBe(400);
    expect(auth.touched).toEqual([]);
  });

  it('serves the OIDC discovery alias from the routed scope’s issuer', async () => {
    const scope = ulid();
    const res = await app.request(
      '/.well-known/openid-configuration',
      { headers: { 'x-substrat-tenant': ulid(), 'x-substrat-scope': scope, 'x-substrat-router': ROUTER_SECRET } },
      env,
    );
    expect(res.status).toBe(200);
    expect(auth.touched).toEqual([scope]);
  });
});
