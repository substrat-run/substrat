/**
 * Provisioning a desk twice leaves exactly the state provisioning it once did (#1653).
 *
 * Idempotence was always the contract (`mountPlatformSurface`: "`onProvision` is required
 * to be idempotent"), but little leaned on it: a desk was reconciled when an operator
 * pressed "Re-run provisioning", or once after a push moved its version. Since #1653 the
 * platform reconciles every install of a vertical each time the code it RUNS changes —
 * for a listed vertical, every tenant's install, at every promote, with nobody watching.
 * A hook that minted a second service account, re-opened the owner's first-sign-in
 * window, or re-sent anything would do it to every live desk on the platform.
 *
 * So this compares the WHOLE of what a provision writes — every table in the desk's scope
 * database, every table in its tenant's identity directory, and the sweeper roster —
 * after one `/internal/provision`, and again after a second provision (the platform-intent
 * drain's retry) and two `/internal/reconcile`s (the sweep, twice). They must be equal,
 * row for row: nothing duplicated, nothing reset, no window moved, no seat re-opened.
 */
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SCOPE_SWEEPER_NAME } from '@substrat-run/adapter-cloudflare';

const t = tenantId.parse(ulid());
const desk = scopeId.parse(ulid());
const owner = principalId.parse(ulid());

const entitlements = (JSON.parse(env.TEST_INSTALL_ENTITLEMENTS) as string[]).map((entitlementKey) => ({
  entitlementKey,
  expiresAt: null,
  quota: null,
  plan: null,
  grantedAt: null,
  grantedBy: null,
}));

function platform(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://ticket0.test${path}`, {
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

/** The whole of what a provision can have written, for this desk. */
async function everything() {
  const sweeper = env.SWEEPER.get(env.SWEEPER.idFromName(SCOPE_SWEEPER_NAME));
  return {
    scope: await tablesOf(env.SCOPE.get(env.SCOPE.idFromName(desk))),
    identity: await tablesOf(env.AUTH.get(env.AUTH.idFromName(t))),
    roster: await runInDurableObject(sweeper, async (_instance, state) =>
      Object.fromEntries(await state.storage.list({ prefix: 'scope:' })),
    ),
  };
}

describe('ticket0 provision is idempotent (#1653)', () => {
  it('a second provision and two reconciles leave every row exactly as one provision did', async () => {
    expect((await platform('/internal/provision', { tenantId: t, scopeId: desk, owner, entitlements })).status).toBe(201);
    const once = await everything();

    // The drain's retry, then the sweep reaching the desk on two promotes.
    expect((await platform('/internal/provision', { tenantId: t, scopeId: desk, owner, entitlements })).status).toBe(201);
    for (let i = 0; i < 2; i++) {
      expect((await platform('/internal/reconcile', { tenantId: t, scopeId: desk, entitlements })).status).toBe(200);
    }
    const again = await everything();

    // The comparison is only worth something if the first provision wrote things: the
    // service accounts' role tuples, the owner seat, the desk on the roster.
    expect(once.scope['_substrat_tuples']!.length).toBeGreaterThan(1);
    expect(once.identity['owner_of_record']).toHaveLength(1);
    expect(once.identity['pending_owner']).toHaveLength(1);
    expect(Object.keys(once.roster)).toContain(`scope:${desk}`);

    expect(again).toEqual(once);
  });
});
