/**
 * Provisioning a Manyfold site twice leaves exactly the state provisioning it once did
 * (#1653).
 *
 * Manyfold is LISTED, so its installs are other tenants' scopes, and since #1653 the
 * platform reconciles every one of them at every promote — the reconcile follows the
 * version each scope RUNS, and a listed vertical's promote changes that for all of them
 * at once. Its provision hook seats the owner (the first-sign-in window, #925) and records
 * the site in the tenant's own registry (M2). Re-running it must neither re-open a seat
 * that was claimed nor reorder the site switcher.
 *
 * So this compares the WHOLE of what a provision writes — every table in the site's scope
 * database and every table in its tenant's identity directory — after one
 * `/internal/provision`, and again after a second provision (the platform-intent drain's
 * retry) and two `/internal/reconcile`s (the sweep, on two promotes). Row for row.
 */
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';

const t = tenantId.parse(ulid());
const site = scopeId.parse(ulid());
const owner = principalId.parse(ulid());

/** Exactly what a dashboard install projects (package.json `substrat.entitlements`). */
const entitlements = (JSON.parse(env.TEST_INSTALL_ENTITLEMENTS) as string[]).map((entitlementKey) => ({
  entitlementKey,
  expiresAt: null,
  quota: null,
  plan: null,
  grantedAt: null,
  grantedBy: null,
}));

function platform(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://manyfold.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-substrat-platform': env.PLATFORM_SECRET },
    body: JSON.stringify(body),
  });
}

/** Every row of every table in one Durable Object's SQLite, order-free. */
function tablesOf(stub: DurableObjectStub): Promise<Record<string, string[]>> {
  return runInDurableObject(stub, async (_instance, state) => {
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

/** The whole of what a provision can have written, for this site. */
async function everything() {
  return {
    scope: await tablesOf(env.SCOPE.get(env.SCOPE.idFromName(site))),
    identity: await tablesOf(env.AUTH.get(env.AUTH.idFromName(t))),
  };
}

describe('manyfold provision is idempotent (#1653)', () => {
  it('a second provision and two reconciles leave every row exactly as one provision did', async () => {
    const install = { tenantId: t, scopeId: site, owner, slug: 'north-yard', name: 'North Yard', entitlements };
    expect((await platform('/internal/provision', install)).status).toBe(201);
    const once = await everything();

    // The drain's retry, then the sweep reaching the site on two promotes.
    expect((await platform('/internal/provision', install)).status).toBe(201);
    for (let i = 0; i < 2; i++) {
      expect((await platform('/internal/reconcile', { tenantId: t, scopeId: site, entitlements })).status).toBe(200);
    }
    const again = await everything();

    // The comparison is only worth something if the first provision wrote things: the
    // owner's role tuple, the owner seat and its window, and the site in the registry.
    expect(once.scope['_substrat_tuples']!.length).toBeGreaterThan(0);
    expect(once.identity['owner_of_record']).toHaveLength(1);
    expect(once.identity['pending_owner']).toHaveLength(1);
    expect(JSON.stringify(once.identity)).toContain('north-yard');

    expect(again).toEqual(once);
  });
});
