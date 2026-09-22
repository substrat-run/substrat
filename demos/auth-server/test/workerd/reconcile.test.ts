/**
 * `/internal/reconcile` on the real worker and the real `AuthServerDO`, in workerd (#1660).
 *
 * auth-server is LISTED, so its installs are other tenants' scopes, and since #1653 the
 * platform reconciles every one of them after each promote — the reconcile follows the
 * version a scope RUNS, and a listed vertical's promote changes that for all of them at
 * once. Until this route existed the catch-all answered 501, the sweep counted every install
 * `unsupported`, wrote no receipt, and asked the same installs again on every pass.
 *
 * The route's claim is that a reconcile is harmless on a live install — in particular that it
 * does not blank the `{slug, name}` a provision recorded, because a reconcile's body carries
 * neither (vertical-host's `reconcileBody`). So the first test compares the WHOLE of the
 * issuer's SQLite, table by table and row by row, after one provision and after a second
 * provision plus two reconciles (the drain's retry, then the sweep on two promotes).
 */
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';

const t = tenantId.parse(ulid());
const owner = ulid();

function platform(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`https://auth-server.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-substrat-platform': env.PLATFORM_SECRET, ...headers },
    body: JSON.stringify(body),
  });
}

const stubOf = (scope: string) => env.AUTH.get(env.AUTH.idFromName(scope));

/** Every row of every table in one issuer's SQLite, order-free. */
function dumpOf(scope: string): Promise<Record<string, string[]>> {
  return runInDurableObject(stubOf(scope), async (_instance, state) => {
    const names = [
      ...state.storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
      ),
    ].map((r) => String(r.name));
    const out: Record<string, string[]> = {};
    for (const name of names) {
      out[name] = [...state.storage.sql.exec(`SELECT * FROM "${name}"`)].map((r) => JSON.stringify(r)).sort();
    }
    return out;
  });
}

/** What `provisionInstance` recorded for a scope, read off the issuer's own `config` table. */
function recordedInstance(scope: string): Promise<unknown> {
  return runInDurableObject(stubOf(scope), async (_instance, state) => {
    const row = [...state.storage.sql.exec("SELECT value FROM config WHERE key = 'instance'")][0] as
      | { value: string }
      | undefined;
    return row ? JSON.parse(row.value) : null;
  });
}

const install = (scope: string) => ({
  tenantId: t,
  scopeId: scope,
  owner,
  slug: 'acme-auth',
  name: 'Acme Auth',
  // Delivered WITH provisioning, so the first provision seeds an administrator and the dump
  // has users and accounts in it — a comparison over an empty user table proves little.
  config: { ADMIN_EMAIL: 'root@acme.test', ADMIN_PASSWORD: 'correct-horse-battery' },
});

describe('auth-server /internal/reconcile is harmless on a live install (#1660)', () => {
  it('a second provision and two reconciles leave every row exactly as one provision did', async () => {
    const scope = scopeId.parse(ulid());
    expect((await platform('/internal/provision', install(scope))).status).toBe(201);
    const once = await dumpOf(scope);

    // The drain's retry, then the sweep reaching the install on two promotes. A reconcile
    // carries a tenant and a scope, and whatever else the platform gathered — never a slug,
    // a name or config.
    expect((await platform('/internal/provision', install(scope))).status).toBe(201);
    for (let i = 0; i < 2; i++) {
      const res = await platform('/internal/reconcile', {
        tenantId: t,
        scopeId: scope,
        entitlements: [],
        identityLinks: [],
        connectionGrants: [],
        connectionKeys: [],
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ tenantId: t, scopeId: scope });
    }
    const again = await dumpOf(scope);

    // The comparison is only worth something if the first provision wrote things: the
    // instance record, the delivered config, the seeded administrator, the console client.
    expect(once['config']!.some((r) => r.includes('"instance"'))).toBe(true);
    expect(once['config']!.some((r) => r.includes('cfg:ADMIN_EMAIL'))).toBe(true);
    expect(once['user']).toHaveLength(1);
    expect(Object.values(once).filter((rows) => rows.length > 0).length).toBeGreaterThan(3);

    expect(again).toEqual(once);
  });

  it('a reconcile does not blank the instance name or slug', async () => {
    const scope = scopeId.parse(ulid());
    await platform('/internal/provision', install(scope));
    const recorded = { tenantId: t, scopeId: scope, slug: 'acme-auth', name: 'Acme Auth' };
    expect(await recordedInstance(scope)).toEqual(recorded);

    expect((await platform('/internal/reconcile', { tenantId: t, scopeId: scope })).status).toBe(200);

    expect(await recordedInstance(scope)).toEqual(recorded);
  });
});

describe('auth-server /internal/reconcile refuses what it cannot vouch for (#1660)', () => {
  it('answers 409 for a scope that was never provisioned, and provisions nothing by asking', async () => {
    const scope = scopeId.parse(ulid());
    const res = await platform('/internal/reconcile', { tenantId: t, scopeId: scope });
    // A 2xx would write a receipt for a provision that never happened.
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('no instance of record');
    expect(await recordedInstance(scope)).toBeNull();
  });

  it('answers 409 when the recorded instance belongs to another tenant, and leaves it as it was', async () => {
    const scope = scopeId.parse(ulid());
    await platform('/internal/provision', install(scope));
    const before = await dumpOf(scope);

    const res = await platform('/internal/reconcile', { tenantId: tenantId.parse(ulid()), scopeId: scope });

    expect(res.status).toBe(409);
    expect(await dumpOf(scope)).toEqual(before);
  });

  it('refuses a caller without the platform secret, and a malformed body', async () => {
    const scope = scopeId.parse(ulid());
    await platform('/internal/provision', install(scope));
    expect((await platform('/internal/reconcile', { tenantId: t, scopeId: scope }, { 'x-substrat-platform': 'wrong' })).status).toBe(403);
    expect((await platform('/internal/reconcile', { scopeId: scope })).status).toBe(400);
    expect((await platform('/internal/reconcile', { tenantId: t, scopeId: 'not-a-ulid' })).status).toBe(400);
  });
});

describe('the rest of /internal/* is still an honest 501 (#1660)', () => {
  it.each(['/internal/snapshot', '/internal/restore', '/internal/rewind'])('POST %s', async (path) => {
    const res = await platform(path, {});
    expect(res.status).toBe(501);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(((await res.json()) as { error: string }).error).toContain('auth-server does not implement');
  });
});

/**
 * The platform's registration of a vertical's MCP endpoint (#1619), on the real worker and
 * the real `AuthServerDO`: `/internal/configure` carrying `substrat:resources:<scope>`
 * becomes rows in the DO's own `oauth_resource`, and the plugin reads them to decide
 * whether `/authorize` may mint for a `resource`.
 *
 * In workerd because node SQLite is not DO SQLite. The rows are written by raw SQL and read
 * back by drizzle's DO driver inside Better Auth, so the claim that the two agree about
 * types — timestamps, booleans, the metadata text — is only worth something here.
 */
describe('auth-server registers the MCP resources the platform delivers (#1619)', () => {
  const app = scopeId.parse(ulid());
  const key = `substrat:resources:${app}`;
  const resource = 'https://desk.acme.test/api/mcp';
  const redirect = 'https://mcp-client.test/callback';

  const configure = (scope: string, entries: { key: string; value: string }[]) =>
    platform('/internal/configure', { scopeId: scope, entries });

  /** Straight at the issuer DO, as the router would deliver it. */
  const issuer = (scope: string, path: string, init?: RequestInit) =>
    stubOf(scope).fetch(`https://auth-server.test${path}`, init);

  async function mcpClient(scope: string): Promise<string> {
    const res = await issuer(scope, '/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Probe MCP Client',
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { client_id: string }).client_id;
  }

  /** Where `/authorize` sends a signed-out browser asking for `resource`. */
  async function authorizeFor(scope: string, clientId: string, target: string): Promise<string> {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirect,
      scope: 'openid',
      state: 'st',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      resource: target,
    });
    // `manual`: a stub's fetch otherwise FOLLOWS the 302, and the DO has no /login to land on.
    const res = await issuer(scope, `/api/auth/oauth2/authorize?${q}`, {
      headers: { 'sec-fetch-mode': 'navigate' },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    return res.headers.get('location') ?? '';
  }

  it('turns the delivery into a row the plugin mints for, and un-registers it on ""', async () => {
    const scope = scopeId.parse(ulid());
    expect((await platform('/internal/provision', install(scope))).status).toBe(201);
    const clientId = await mcpClient(scope);

    // Before: the resource is not configured, the failure the issue reported.
    expect(await authorizeFor(scope, clientId, resource)).toContain('error=invalid_target');

    expect((await configure(scope, [{ key, value: JSON.stringify([resource]) }])).status).toBe(200);
    const rows = (await dumpOf(scope))['oauth_resource']!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(resource);
    // The registry is the one source of truth: the entry is not ALSO kept as delivered config.
    expect((await dumpOf(scope))['config']!.some((r) => r.includes('substrat:resources'))).toBe(false);

    // A login page, not a refusal — and no link between client and resource was needed.
    const location = await authorizeFor(scope, clientId, resource);
    expect(location.startsWith('/login?')).toBe(true);

    expect((await configure(scope, [{ key, value: '' }])).status).toBe(200);
    expect((await dumpOf(scope))['oauth_resource']).toEqual([]);
    expect(await authorizeFor(scope, clientId, resource)).toContain('error=invalid_target');
  });

  it('is idempotent on DO SQLite: the same delivery twice leaves every table as once did', async () => {
    const scope = scopeId.parse(ulid());
    await platform('/internal/provision', install(scope));
    await configure(scope, [{ key, value: JSON.stringify([resource, 'https://crm.acme.test/api/mcp']) }]);
    const once = await dumpOf(scope);
    expect(once['oauth_resource']).toHaveLength(2);

    await configure(scope, [{ key, value: JSON.stringify([resource, 'https://crm.acme.test/api/mcp']) }]);

    expect(await dumpOf(scope)).toEqual(once);
  });

  /**
   * All-or-nothing on DO SQLite. Each `exec` commits on its own there unless it is wrapped,
   * so a failure halfway through un-registering a multi-host app would leave part of its
   * set removed, and a deleted app has no later reconcile to finish it. The failure is
   * injected with a trigger that aborts the SECOND delete, once the first has gone through.
   */
  it('un-registers a multi-host set all-or-nothing: a failure halfway removes nothing', async () => {
    const scope = scopeId.parse(ulid());
    await platform('/internal/provision', install(scope));
    await configure(scope, [{ key, value: JSON.stringify([resource, 'https://crm.acme.test/api/mcp']) }]);
    const before = await dumpOf(scope);
    expect(before['oauth_resource']).toHaveLength(2);

    await runInDurableObject(stubOf(scope), async (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TRIGGER fail_second_delete BEFORE DELETE ON oauth_resource
         WHEN (SELECT COUNT(*) FROM oauth_resource) < 2
         BEGIN SELECT RAISE(ABORT, 'injected: the second delete fails'); END`,
      );
    });
    const failed = await configure(scope, [{ key, value: '' }]);
    await runInDurableObject(stubOf(scope), async (_instance, state) => {
      state.storage.sql.exec('DROP TRIGGER fail_second_delete');
    });

    expect(failed.status).toBe(400);
    expect(await dumpOf(scope)).toEqual(before);

    // The twin: the same delivery with nothing failing removes the whole set.
    expect((await configure(scope, [{ key, value: '' }])).status).toBe(200);
    expect((await dumpOf(scope))['oauth_resource']).toEqual([]);
  });

  it('refuses a malformed delivery whole, writing none of it', async () => {
    const scope = scopeId.parse(ulid());
    await platform('/internal/provision', install(scope));
    const before = await dumpOf(scope);

    const res = await configure(scope, [
      { key: 'ALLOW_SIGNUP', value: 'true' },
      { key: `substrat:resources:${ulid()}`, value: JSON.stringify([resource]) },
      { key, value: '["/relative/api/mcp"]' },
    ]);

    expect(res.status).toBe(400);
    expect(await dumpOf(scope)).toEqual(before);
  });

  it('refuses a caller without the platform secret', async () => {
    const scope = scopeId.parse(ulid());
    await platform('/internal/provision', install(scope));
    const before = await dumpOf(scope);
    const res = await platform(
      '/internal/configure',
      { scopeId: scope, entries: [{ key, value: JSON.stringify([resource]) }] },
      { 'x-substrat-platform': 'wrong' },
    );
    expect(res.status).toBe(403);
    expect(await dumpOf(scope)).toEqual(before);
  });
});
