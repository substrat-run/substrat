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
