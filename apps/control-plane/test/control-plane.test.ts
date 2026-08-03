import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { DEV_ACTOR_HEADER } from '@substrat-run/control-plane-api';
import { platformActorId, principalId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { mintSession, type OidcEnv } from '@substrat-run/oidc-rp';
import { d1StaffRoster, listStaff } from '../src/staff-roster.js';

/**
 * Slice 1's definition of done, as an automated workerd test (first-flow.md §4):
 * the control-plane worker stands up, `/tenants` starts empty, a POST persists
 * into the durable ControlPlaneDO, and an unauthenticated request fails closed.
 *
 * Persistence is asserted two ways. Within the worker: a POST is read back by a
 * later GET. Across the coordinator: a *fresh* `CloudflareScopeHost` — a new
 * stateless coordinator, exactly what a real second request or the console is —
 * reads the same tenant straight from the DO. That second assertion is the real
 * property: the directory lives in durable DO storage, not in any isolate's
 * memory, so any coordinator that reaches this DO namespace sees it.
 */

// A valid ULID platform actor; the dev stub (enabled via ALLOW_DEV_ACTOR in
// vitest.config.ts) trusts this header verbatim.
const ACTOR = ulid();
const authed = {
  [DEV_ACTOR_HEADER]: ACTOR,
  'content-type': 'application/json',
};

describe('shared control-plane worker', () => {
  it('serves an empty tenant registry before anything is created', async () => {
    const res = await SELF.fetch('https://cp.test/api/tenants', { headers: authed });
    expect(res.status).toBe(200);
    // Every list route answers the platform page envelope (contracts pagination.ts);
    // a short (here: empty) page carries `nextCursor: null` — the walk is done.
    expect(await res.json()).toEqual({ entries: [], nextCursor: null });
  });

  it('persists a created tenant through the durable DO', async () => {
    const id = ulid();
    const create = await SELF.fetch('https://cp.test/api/tenants', {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ id, slug: 'acme', name: 'Acme AB' }),
    });
    expect(create.status).toBe(201);
    expect(await create.json()).toMatchObject({ id, slug: 'acme', name: 'Acme AB', status: 'active' });

    // Read back through the worker — a page envelope now, entries inside.
    const list = (await (await SELF.fetch('https://cp.test/api/tenants', { headers: authed })).json()) as {
      entries: { id: string }[];
    };
    expect(list.entries.map((t) => t.id)).toContain(id);

    // Read back through a brand-new coordinator against the same DO namespace —
    // proof the row is in durable storage, reachable by any stateless host.
    const fresh = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
    // Reads take an actor now (K-24) — the same one the dev stub authenticated as.
    const tenants = await fresh.admin.listTenants(platformActorId.parse(ACTOR));
    expect(tenants.map((t) => t.id)).toContain(id);
    await fresh.close();
  });

  it('fails closed without a platform actor', async () => {
    const res = await SELF.fetch('https://cp.test/api/tenants');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
  });
});

/**
 * The staff roster (#42). Before this, every rostered email mapped to ONE
 * hardcoded actor, so the admin log could not distinguish which operator
 * suspended a tenant — the surface could act without a durable record of *who*,
 * which §4.4 says is worse than no surface at all.
 */
describe('staff roster', () => {
  const resolver = d1StaffRoster(env.AUTH_DB);
  const ACTOR_A = '01JZ0000000000000000000AAA';
  const ACTOR_B = '01JZ0000000000000000000BBB';

  beforeAll(async () => {
    await env.AUTH_DB.exec(
      'CREATE TABLE IF NOT EXISTS staff_actor (email TEXT PRIMARY KEY, actor TEXT NOT NULL, name TEXT, added_at TEXT NOT NULL, revoked_at TEXT)',
    );
    const add = (email: string, actor: string, revokedAt: string | null) =>
      env.AUTH_DB.prepare(
        'INSERT OR REPLACE INTO staff_actor (email, actor, name, added_at, revoked_at) VALUES (?, ?, NULL, ?, ?)',
      )
        .bind(email, actor, new Date().toISOString(), revokedAt)
        .run();
    await add('ada@substrat.run', ACTOR_A, null);
    await add('grace@substrat.run', ACTOR_B, null);
    await add('gone@substrat.run', '01JZ0000000000000000000CCC', new Date().toISOString());
    await add('broken@substrat.run', 'not-a-ulid', null);
  });

  it('resolves each operator to their OWN actor', async () => {
    // The whole point: two operators must be distinguishable in the audit trail.
    const a = await resolver({ email: 'ada@substrat.run' });
    const b = await resolver({ email: 'grace@substrat.run' });
    expect(a).toBe(ACTOR_A);
    expect(b).toBe(ACTOR_B);
    expect(a).not.toBe(b);
  });

  it('is case-insensitive on email', async () => {
    expect(await resolver({ email: 'Ada@Substrat.RUN' })).toBe(ACTOR_A);
  });

  it('refuses someone not on the roster', async () => {
    expect(await resolver({ email: 'stranger@example.com' })).toBeNull();
  });

  it('refuses a revoked operator — the row stays as evidence', async () => {
    expect(await resolver({ email: 'gone@substrat.run' })).toBeNull();
    // Tombstone, not delete (K-21): revoking access must not erase the record
    // that it was once granted.
    const row = await env.AUTH_DB.prepare(
      'SELECT revoked_at FROM staff_actor WHERE email = ?',
    )
      .bind('gone@substrat.run')
      .first<{ revoked_at: string | null }>();
    expect(row?.revoked_at).toEqual(expect.any(String));
  });

  it('fails closed on a malformed stored actor rather than coercing it', async () => {
    // An actor the audit log cannot name is exactly what §4.4 refuses to write.
    expect(await resolver({ email: 'broken@substrat.run' })).toBeNull();
  });

  it('lists the roster, revoked included, for "who has platform access"', async () => {
    const roster = await listStaff(env.AUTH_DB);
    const emails = roster.map((r) => r.email);
    expect(emails).toContain('ada@substrat.run');
    expect(emails).toContain('gone@substrat.run');
    // Live first, revoked last — the roster reads as a roster, not a history.
    expect(roster.findIndex((r) => r.revokedAt !== null)).toBeGreaterThan(
      roster.findIndex((r) => r.revokedAt === null),
    );
    // A row whose stored actor is unusable is still LISTED, with a null actor —
    // one bad row must not blank the roster, and hiding it would hide the problem.
    const broken = roster.find((r) => r.email === 'broken@substrat.run');
    expect(broken).toBeDefined();
    expect(broken?.actor).toBeNull();
  });
});

describe('no public account surface (OIDC)', () => {
  // Identity is AuthHero now (an OIDC relying party), so the control plane has no
  // signup or password endpoint at all — the old "Better Auth public signup, gated
  // by the roster" hole (#47) cannot exist because there is nothing to gate.
  // Authorization is still the roster (see 'staff roster' above); this guards that
  // no credential-creation route creeps back onto the deployed origin.
  it('exposes no sign-up endpoint', async () => {
    const res = await SELF.fetch('https://cp.test/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'stranger@example.com', password: 'hunter2hunter2' }),
    });
    expect(res.ok).toBe(false);
  });
});

/**
 * The live BUILDER path (builder-plane.md §4/§5), end-to-end in workerd: a NON-staff
 * session resolves — via the shared identity directory — to a builder principal, and the
 * control plane forms `<tenantSlug>/<name>` from the authenticated tenant. What's under
 * test: self-serve with no vetting roster, the prefix the builder never types, and that a
 * user with no workspace is declined (fail-closed).
 *
 * In THIS file (not its own) on purpose: storage is shared across files
 * (isolatedStorage: false), so seeding a tenant elsewhere would pollute the "empty
 * registry" test above. Here the seed runs after it, in guaranteed document order.
 */
describe('builder auth — live self-serve path', () => {
  const oidcEnv = { SESSION_SECRET: env.SESSION_SECRET } as unknown as OidcEnv;
  const PROVIDER = 'authhero';
  // The same fixed resolver actor builder-auth.ts uses to read the directory.
  const RESOLVER = platformActorId.parse('01JZ000000000000000000BDR1');
  const userId = ulid();
  const email = 'builder@acme.example';

  const sessionFor = (id: string, mail: string): Promise<string> =>
    mintSession(oidcEnv, { id, email: mail, name: 'Builder' });

  beforeAll(async () => {
    // The staff roster table must exist so staff auth fails closed (returns null, not
    // throws) and the request falls through to the BUILDER path. Empty: the builder is
    // deliberately not staff. In prod this table is a migration; here we seed it.
    await env.AUTH_DB.exec(
      'CREATE TABLE IF NOT EXISTS staff_actor (email TEXT PRIMARY KEY, actor TEXT NOT NULL, name TEXT, added_at TEXT NOT NULL, revoked_at TEXT)',
    );
    // Seed a tenant + link the OIDC identity to it, the way dashboard sign-up would.
    const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(RESOLVER, { id: t, slug: 'acme-co', name: 'Acme Co' });
    await host.admin.registerIdentityPool(RESOLVER, { provider: PROVIDER, topology: 'central', tenantId: null });
    await host.admin.linkIdentity(RESOLVER, {
      tenantId: t,
      provider: PROVIDER,
      externalId: userId,
      principal: principalId.parse(ulid()),
    });
    await host.close();
  });

  it('whoami resolves the session to its tenants', async () => {
    const token = await sessionFor(userId, email);
    const res = await SELF.fetch('https://cp.test/api/auth/whoami', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string } | null; tenants: { slug: string }[] };
    expect(body.user?.id).toBe(userId);
    expect(body.tenants.map((t) => t.slug)).toContain('acme-co');
  });

  it('whoami is empty for no session', async () => {
    const res = await SELF.fetch('https://cp.test/api/auth/whoami');
    expect(await res.json()).toEqual({ user: null, tenants: [] });
  });

  it('a builder pushes a BARE slug and the control plane forms <tenantSlug>/<name>', async () => {
    const token = await sessionFor(userId, email);
    // Register (claim) a bare `helpdesk`; the id comes back prefixed — the builder never
    // typed `acme-co/`.
    const res = await SELF.fetch('https://cp.test/api/verticals', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'helpdesk', name: 'Helpdesk', source: 'cli' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ slug: 'acme-co/helpdesk' });

    // The list is filtered to the builder's own namespace (page envelope).
    const list = (await (
      await SELF.fetch('https://cp.test/api/verticals', { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { entries: { slug: string }[] };
    expect(list.entries.map((v) => v.slug)).toContain('acme-co/helpdesk');

    // Staff-only surfaces stay closed to a builder (default-deny confinement) —
    // including the identity mirror: a builder must not write the directory
    // that authenticates builders.
    const tenants = await SELF.fetch('https://cp.test/api/tenants', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(tenants.status).toBe(403);
    const mirror = await SELF.fetch(`https://cp.test/api/tenants/${ulid()}/identities`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'authhero', externalId: 'auth0|self', principal: ulid() }),
    });
    expect(mirror.status).toBe(403);
  });

  it('declines a signed-in user who has no workspace yet (fail closed)', async () => {
    const token = await sessionFor(ulid(), 'nobody@example.com'); // never seeded
    const res = await SELF.fetch('https://cp.test/api/verticals', {
      headers: { authorization: `Bearer ${token}` },
    });
    // No builder tenant → the reader declines → the API falls through to 401.
    expect(res.status).toBe(401);
  });
});

/**
 * The router kick's landing endpoint (platform-intents.md §"router kick"). The router
 * pings `/internal/drain-scope` so a scope's just-enqueued platform intent runs in
 * seconds. It is platform-secret gated, and this deployment binds no PLATFORM_SECRET —
 * so, per the kernel's `assertPlatformCall`, an unconfigured secret is a REFUSAL, never a
 * bypass. The security-relevant property: a deployment that never set the secret must not
 * drain scopes for an anonymous caller. The drain's own logic is unit-tested in
 * control-plane-api's platform-drain suite; here we prove the surface fails closed.
 */
describe('router kick — /internal/drain-scope', () => {
  it('refuses when the platform secret is not configured (fails closed)', async () => {
    const res = await SELF.fetch('https://cp.test/internal/drain-scope', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-substrat-platform': 'anything' },
      body: JSON.stringify({ tenantId: ulid(), scopeId: ulid() }),
    });
    expect(res.status).toBe(403);
  });
});
