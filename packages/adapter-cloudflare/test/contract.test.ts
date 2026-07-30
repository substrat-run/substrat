import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { warmControlPlane } from './do-warmup.js';
import {
  orgId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type EntitlementGrant,
  type ScopeTable,
} from '@substrat-run/contracts';
import { ulid, UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import {
  billedMod,
  connectorTestFetch,
  permissionContractSuite,
  scopeHostContractSuite,
} from '@substrat-run/contract-tests';
import { CloudflareScopeHost } from '../src/host.js';

// Absorb the inter-file DO reload before any suite's first directory call
// (see do-warmup.ts) — file-level, so it runs before every suite below.
beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

// The scope-host suite runs against an allow-all checker (it exercises no
// ctx.check). Runtime module registration is unsupported on CF — the ScopeDO
// closes over a code-time module set — so that one late-registration test is
// skipped; every other test is shared unchanged (D-14).
scopeHostContractSuite(
  'adapter-cloudflare',
  async () => {
    const host = new CloudflareScopeHost({
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      fetch: connectorTestFetch,
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      checker: UNSAFE_allowAllChecker,
    });
    return { host, cleanup: async () => host.close() };
  },
  { supportsRuntimeRegistration: false },
);

// The permission suite runs against the DO's default tuple checker (scope tuples
// in the ScopeDO, tenant tuples + roles in the ControlPlaneDO).
permissionContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});


/**
 * The Cloudflare half of #32 — the same guarantee the pure adapter asserts, on the
 * adapter that is actually deployed. It matters more here: the projection is done
 * by the COORDINATOR after the ScopeDO reports, so a rejected `migrate()` used to
 * skip the write entirely and leave the scope rendering as healthy.
 *
 * Points at BROKEN_SCOPE (worker.ts) — a DO class carrying only the module whose
 * migration cannot apply, since a DO closes over a code-time module set.
 *
 * Lives in THIS file rather than its own: the pool runs `singleWorker` with
 * `isolatedStorage: false`, and a second test file re-evaluates the worker mid-run,
 * which invalidates every live DO ("worker.ts changed").
 */
describe('migration failure is recorded in the directory', () => {
  let host: CloudflareScopeHost;
  const staff = platformActorId.parse(ulid());
  const alice = principalId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());

  beforeAll(async () => {
    host = new CloudflareScopeHost({
      scope: env.BROKEN_SCOPE,
      controlPlane: env.CONTROL_PLANE,
      checker: UNSAFE_allowAllChecker,
    });
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    // Default-deny (§4.3): without the grant the module never loads and its
    // migration never runs, so this suite would pass vacuously.
    await host.admin.grantEntitlement(staff, t, 'broken');
    await expect(
      host.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu' }),
    ).rejects.toThrow(/scope fails closed/);
  });

  afterAll(async () => {
    await host.close();
  });

  it('fails the scope closed rather than serving a half-migrated schema', async () => {
    await expect(host.getScope(alice, t, s)).rejects.toThrow(/scope fails closed/);
  });

  it('records which module@version failed, through the coordinator', async () => {
    const record = await host.admin.getScopeRecord(staff, t, s);
    expect(record?.migrationFailure).not.toBeNull();
    expect(record?.migrationFailure?.version).toBe('@test/broken@0002-broken');
    expect(record?.migrationFailure?.attempts).toBeGreaterThan(0);
  });

  it('projects the count that actually landed, not the pre-attempt value', async () => {
    const record = await host.admin.getScopeRecord(staff, t, s);
    expect(record?.schemaVersion).toBe('1');
  });

  /**
   * The #49 retry affordance, proven at the exact seam the issue named: the
   * ScopeDO memoises its migration promise, and a REJECTED promise stays
   * assigned — so an ordinary wake on a warm instance returns the cached
   * rejection without re-attempting anything. The instance-run counter is the
   * observable that tells the two apart (the directory's `attempts` cannot:
   * the coordinator increments it on cached rejections too).
   */
  it('migrateScope defeats the memoised rejection — a fresh attempt, not the cached one (#49)', async () => {
    interface MigrationProbe {
      migrationAttemptsOnInstance(): Promise<number>;
    }
    const probe = env.BROKEN_SCOPE.get(env.BROKEN_SCOPE.idFromName(s)) as unknown as MigrationProbe;
    const before = await probe.migrationAttemptsOnInstance();
    expect(before).toBeGreaterThan(0);

    // The ordinary wake: rejects, but from the cache — no new run on this instance.
    await expect(host.getScope(alice, t, s)).rejects.toThrow(/scope fails closed/);
    expect(await probe.migrationAttemptsOnInstance()).toBe(before);

    // The sweep's door: clears the latch, actually re-runs, reports structurally.
    const outcome = await host.migrateScope(t, s);
    expect(outcome).toMatchObject({
      status: 'failed',
      failure: { version: '@test/broken@0002-broken' },
    });
    expect(await probe.migrationAttemptsOnInstance()).toBe(before + 1);
  });

  it('each retry advances the directory attempt counter, so the sweep can back off (#49)', async () => {
    const read = async () =>
      (await host.admin.getScopeRecord(staff, t, s))?.migrationFailure?.attempts ?? 0;
    const before = await read();
    expect(before).toBeGreaterThan(0);
    await host.migrateScope(t, s);
    expect(await read()).toBe(before + 1);
  });
});

/**
 * Scope-local permissions, Phase 1 (docs/design/scope-local-permissions.md): the
 * ScopeDO can evaluate a tenant-level role from its OWN projected storage instead
 * of the control-plane DO. This proves the local reader is parity with RPC, that a
 * tombstoned projection stops granting, and — the load-bearing safety property —
 * that flipping a scope to 'local' WITHOUT projecting denies (fail closed), even
 * where the RPC path would have allowed. Lives in this file for the same
 * single-worker reason as the block above.
 */
describe('scope-local permissions — the projected local reader (Phase 1)', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const sProj = scopeId.parse(ulid()); // projected → local
  const sEmpty = scopeId.parse(ulid()); // flipped to local with nothing projected
  const alice = principalId.parse(ulid());
  const PERM_ADMIN = permissionKey.parse('perm:admin');
  let host: CloudflareScopeHost;

  const probe = async (scope: typeof sProj): Promise<boolean> =>
    (await (await host.getScope(alice, t, scope)).invoke<{ allowed: boolean }>('perm/probe', { permission: PERM_ADMIN }))
      .allowed;

  interface ProjectionRpc {
    projectRole(tenantId: string, role: { key: string; permissions: string[]; source: string }): Promise<void>;
    projectTenantTuple(tenantId: string, subject: string, relation: string, object: string, expiresAt: string | null, revokedAt?: string | null): Promise<void>;
    revokeProjectedRole(tenantId: string, key: string, revokedAt: string): Promise<void>;
    setPermissionSource(source: 'local' | 'control-plane'): Promise<void>;
  }
  const projection = (scope: string): ProjectionRpc =>
    env.SCOPE.get(env.SCOPE.idFromName(scope)) as unknown as ProjectionRpc;

  beforeAll(async () => {
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.admin.grantEntitlement(staff, t, 'perm'); // default-deny (§4.3)
    for (const s of [sProj, sEmpty]) {
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
      await host.admin.activateScope(staff, t, s);
    }
    // A tenant-level role — lands in the control plane, so it resolves for BOTH
    // scopes over RPC until one is flipped to local.
    await host.admin.defineRole(staff, t, { key: 'admin', permissions: [PERM_ADMIN], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'admin', node: { tenantId: t, scopeId: null } });
  });

  afterAll(async () => host.close());

  it('resolves via RPC by default, then identically via the local projection', async () => {
    expect(await probe(sProj)).toBe(true); // RPC baseline

    const p = projection(sProj);
    await p.projectRole(t, { key: 'admin', permissions: [PERM_ADMIN], source: 'vertical' });
    await p.projectTenantTuple(t, `principal:${alice}`, 'role:admin', `tenant:${t}`, null);
    await p.setPermissionSource('local');
    expect(await probe(sProj)).toBe(true); // now resolved locally — parity
  });

  it('a tombstoned projected role stops granting (K-21)', async () => {
    await projection(sProj).revokeProjectedRole(t, 'admin', new Date().toISOString());
    expect(await probe(sProj)).toBe(false);
  });

  it('fails closed: local source with nothing projected denies, though RPC would allow', async () => {
    expect(await probe(sEmpty)).toBe(true); // RPC still allows — the role is in the control plane
    await projection(sEmpty).setPermissionSource('local'); // flip WITHOUT projecting
    expect(await probe(sEmpty)).toBe(false); // empty projection ⇒ deny
  });
});

/**
 * Scope-local permissions, Phase 2: with `scopeLocalPermissions` ON, the host
 * PROJECTS a tenant's roles/tuples into its scopes on every tenant-level write and
 * evaluates locally. This exercises the automatic fan-out end to end — including the
 * subtle cases: a tenant role assigned AFTER its scopes exist must still reach them,
 * a membership tombstone must fan out, and `reconcileTenantProjection` must repair a
 * stale scope. (The full permission MODEL is already covered by the RPC contract
 * suite above; this asserts the projection machinery, not the checker algebra.)
 */
describe('scope-local permissions — automatic fan-out on write (Phase 2)', () => {
  let host: CloudflareScopeHost;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  const s2 = scopeId.parse(ulid());
  const alice = principalId.parse(ulid()); // tenant-level admin
  const bob = principalId.parse(ulid()); // scope role at s1 only
  const carol = principalId.parse(ulid()); // org member
  const acme = orgId.parse(ulid());
  const ADMIN = permissionKey.parse('perm:admin');
  const READ = permissionKey.parse('perm:read');

  const probe = async (who: typeof alice, scope: typeof s1, perm: typeof ADMIN): Promise<boolean> =>
    (await (await host.getScope(who, t, scope)).invoke<{ allowed: boolean }>('perm/probe', { permission: perm })).allowed;

  beforeAll(async () => {
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      scopeLocalPermissions: true,
    });
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.admin.grantEntitlement(staff, t, 'perm');
    // Scopes exist FIRST — so the assignments below must fan OUT into them, the
    // case a "project at provision" alone would miss.
    for (const s of [s1, s2]) {
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
      await host.admin.activateScope(staff, t, s);
    }
    await host.admin.defineRole(staff, t, { key: 'admin', permissions: [ADMIN, READ], source: 'vertical' });
    await host.admin.defineRole(staff, t, { key: 'tech', permissions: [READ], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'admin', node: { tenantId: t, scopeId: null } });
    await host.admin.assignRole(staff, { principalId: bob, roleKey: 'tech', node: { tenantId: t, scopeId: s1 } });
    await host.admin.createOrg(staff, { id: acme, tenantId: t, slug: 'acme', name: 'Acme' });
    await host.admin.addMember(staff, t, carol, acme);
    await host.admin.grantToOrg(staff, acme, READ, { tenantId: t, scopeId: null });
  });

  afterAll(async () => host.close());

  it('a tenant role fans out to scopes that already existed when it was assigned', async () => {
    expect(await probe(alice, s1, ADMIN)).toBe(true);
    expect(await probe(alice, s2, ADMIN)).toBe(true);
  });

  it('a scope role stays confined to its scope', async () => {
    expect(await probe(bob, s1, READ)).toBe(true);
    expect(await probe(bob, s2, READ)).toBe(false);
  });

  it('org membership + an org grant fan out (rule 4)', async () => {
    expect(await probe(carol, s1, READ)).toBe(true);
  });

  it('revoking a membership fans the tombstone out — access stops', async () => {
    await host.admin.removeMember(staff, t, carol, acme);
    expect(await probe(carol, s1, READ)).toBe(false);
  });

  it('reconcileTenantProjection repairs a scope whose projection drifted', async () => {
    // Simulate a dropped fan-out by wiping s2's projection directly.
    const stub = env.SCOPE.get(env.SCOPE.idFromName(s2)) as unknown as {
      applyProjection(tenantId: string, roles: unknown[], tuples: unknown[]): Promise<void>;
    };
    await stub.applyProjection(t, [], []);
    expect(await probe(alice, s2, ADMIN)).toBe(false); // stale → denies
    await host.reconcileTenantProjection(t);
    expect(await probe(alice, s2, ADMIN)).toBe(true); // repaired
  });
});

/**
 * Scope-local permissions, Phase 3: a host with NO control plane — a scope-local /
 * untrusted vertical. It provisions via `provisionScopeLocal` (grant the owner at
 * scope level + project the role defs) and serves entirely from the scope's own
 * storage. The null-object control plane no-ops the router-gated hot path
 * (validateScopeAccess / entitlement / audit) and throws for the admin surface it
 * genuinely lacks.
 */
describe('scope-local permissions — a CP-less host (Phase 3)', () => {
  let host: CloudflareScopeHost;
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  const stranger = principalId.parse(ulid());
  const ADMIN = permissionKey.parse('perm:admin');
  const READ = permissionKey.parse('perm:read');

  const probe = async (who: typeof owner, perm: typeof ADMIN): Promise<boolean> =>
    (await (await host.getScope(who, t, s)).invoke<{ allowed: boolean }>('perm/probe', { permission: perm })).allowed;

  beforeAll(async () => {
    // No `controlPlane` — the host runs on the null-object stand-in.
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    await host.provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [ADMIN, READ], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
  });

  afterAll(async () => host.close());

  it("serves the owner's permission from the scope alone — no control plane, entitlement trusted", async () => {
    expect(await probe(owner, ADMIN)).toBe(true);
    expect(await probe(owner, READ)).toBe(true);
  });

  it('denies a stranger (fail closed), still with no control plane', async () => {
    expect(await probe(stranger, ADMIN)).toBe(false);
  });

  it('assignScopeRole grants an invited member the role’s permissions — scope-local, no CP', async () => {
    // The member half of the invite flow: a newly-invited principal, granted the role at
    // scope level, resolves that role's permissions from the scope's own storage.
    const member = principalId.parse(ulid());
    expect(await probe(member, ADMIN)).toBe(false); // no grant yet
    await host.assignScopeRole(s, member, 'office-admin');
    expect(await probe(member, ADMIN)).toBe(true); // now holds the role's perms
    expect(await probe(member, READ)).toBe(true);
    expect(await probe(stranger, READ)).toBe(false); // an un-granted principal is still denied
  });

  it('assignScopeRole to a role the scope never projected grants nothing (fail closed)', async () => {
    const member = principalId.parse(ulid());
    await host.assignScopeRole(s, member, 'not-a-projected-role');
    expect(await probe(member, READ)).toBe(false);
  });

  it('the admin directory surface throws — it genuinely has no control plane', async () => {
    await expect(
      host.admin.createTenant(platformActorId.parse(ulid()), { id: t, slug: `x-${t.toLowerCase()}`, name: 'X' }),
    ).rejects.toThrow(/control plane unavailable/);
  });
});

/**
 * #355 regression: `provisionScopeLocal` must apply the bundled modules' migrations
 * AS PART OF provisioning — not lazily on the first `getScope`. The field symptom was
 * a hosted vertical whose scope had roles projected but `_substrat_migrations = 0` and
 * no own tables. This pins the invariant that provision alone lands the schema, so a
 * freshly-provisioned scope is never born content-less.
 */
describe('provisionScopeLocal applies module migrations at provision (#355)', () => {
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  const READ = permissionKey.parse('perm:read');

  it("creates the modules' own tables and journals them — before any getScope", async () => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    await host.provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [READ], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
    // Read the DO directly: a CP-less host has no `admin.listScopeTables` (it throws).
    // No `getScope`/`invoke` has run against this fresh scope id, so anything present
    // here was applied by `provisionScopeLocal` itself, not by a lazy first open.
    const stub = env.SCOPE.get(env.SCOPE.idFromName(s)) as unknown as {
      introspectTables(): Promise<ScopeTable[]>;
    };
    const tables = await stub.introspectTables();
    const journal = tables.find((tab) => tab.name === '_substrat_migrations');
    expect(journal?.rowCount ?? 0).toBeGreaterThan(0); // the field bug was rowCount = 0
    expect(tables.some((tab) => !tab.system)).toBe(true); // own tables exist, not just the spine
    await host.close();
  });
});

/**
 * #304, the hosted-vertical case: a CP-less scope enforces + reads its entitlements from the
 * PROJECTION passed at provision, with no control-plane binding. This is the whole point —
 * the coordinator's `cp.tenantHoldsEntitlement` is a trusting no-op here, so the DO's projected
 * view is the only source of truth. Registers `billedMod` on the coordinator so its operations
 * carry `requiredEntitlement` (the DO already closes over it), the one thing the ad-hoc Phase 3
 * host above does not do.
 */
describe('scope-local entitlements — a CP-less hosted vertical (#304)', () => {
  let host: CloudflareScopeHost;
  const owner = principalId.parse(ulid());
  const t = tenantId.parse(ulid());
  const enforced = scopeId.parse(ulid()); // provisioned WITH 'billed' → strict, held
  const strict = scopeId.parse(ulid()); // provisioned WITH entitlements:[] → strict, NOT held
  const legacy = scopeId.parse(ulid()); // provisioned WITHOUT entitlements → trust-upstream
  const grant = (entitlementKey: string, over: Partial<EntitlementGrant> = {}): EntitlementGrant => ({
    entitlementKey,
    expiresAt: null,
    quota: null,
    plan: null,
    grantedAt: null,
    grantedBy: null,
    ...over,
  });
  const provision = (scopeId: typeof enforced, entitlements?: EntitlementGrant[]) =>
    host.provisionScopeLocal({
      tenantId: t,
      scopeId,
      owner,
      roles: [{ key: 'office-admin', permissions: [permissionKey.parse('billed:use')], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
      entitlements,
    });

  beforeAll(async () => {
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    host.registerModule(billedMod); // populates the coordinator's operation→SKU map
    await provision(enforced, [grant('billed', { quota: 250, plan: 'pro' })]);
    await provision(strict, []); // entitlements projected, but 'billed' not among them
    await provision(legacy); // no entitlements projected — pre-#304 shape
  });

  afterAll(async () => host.close());

  it('runs a gated operation and reads the projected grant via ctx.entitlement — no CP', async () => {
    const stub = await host.getScope(owner, t, enforced);
    await expect(stub.invoke<string>('billed/act')).resolves.toBe('ran');
    expect(await stub.invoke('billed/read-entitlement', 'billed')).toEqual({
      key: 'billed',
      plan: 'pro',
      quota: 250,
      expiresAt: null,
    });
  });

  it('fails closed on a projected scope that does NOT hold the SKU (strict enforcement)', async () => {
    const stub = await host.getScope(owner, t, strict);
    await expect(stub.invoke('billed/act')).rejects.toThrow(/not entitled/);
  });

  it('trusts upstream on a scope provisioned before entitlements were projected (no false denial)', async () => {
    const stub = await host.getScope(owner, t, legacy);
    await expect(stub.invoke<string>('billed/act')).resolves.toBe('ran');
  });
});

/**
 * #332: a CP-less scope can be left "role definitions projected, permission_source = 'local',
 * zero tuples" — a scope enforcing nothing but denials, unfixable from inside (the owner is
 * signed in and linked to a principal that holds no role). Two guarantees close the hole:
 * `provisionScopeLocal` writes the owner's grant in the SAME unit as the enforcement flip (so a
 * partial write can never brick it), and a reconcile — re-running provisioning with the owner the
 * vertical still remembers — repairs a scope that reached the bricked state another way (e.g. a
 * promote that recreated the scope-DO storage, #321).
 */
describe('#332 — recovery from a scope bricked to zero tuples (CP-less)', () => {
  let host: CloudflareScopeHost;
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  const ADMIN = permissionKey.parse('perm:admin');

  const provision = (scope: typeof s): Promise<void> =>
    host.provisionScopeLocal({
      tenantId: t,
      scopeId: scope,
      owner,
      roles: [{ key: 'office-admin', permissions: [ADMIN], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
  const probe = async (): Promise<boolean> =>
    (await (await host.getScope(owner, t, s)).invoke<{ allowed: boolean }>('perm/probe', { permission: ADMIN }))
      .allowed;

  // Raw DO stub — reproduce the brick and read the enforcement flag exactly as #332 diagnosed it.
  type RawStub = {
    revokeTuple(subject: string, relation: string, object: string, at: string): Promise<boolean>;
    applyProjection(
      tenantId: string,
      roles: { role_key: string; permissions: string; source: string }[],
      tuples: unknown[],
      entitlements?: unknown[],
      scopeTuples?: { subject: string; relation: string; object: string; expires_at: string | null }[],
    ): Promise<void>;
    introspectQuery(sql: string): Promise<{ rows: unknown[][] }>;
  };
  const rawStub = (scope: string): RawStub => env.SCOPE.get(env.SCOPE.idFromName(scope)) as unknown as RawStub;
  const permissionSource = async (scope: string): Promise<string | undefined> =>
    (
      await rawStub(scope).introspectQuery("SELECT value FROM _substrat_meta WHERE key = 'permission_source'")
    ).rows[0]?.[0] as string | undefined;

  beforeAll(async () => {
    // No control plane — the CP-less hosted-vertical shape the issue is about.
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    await provision(s);
  });
  afterAll(async () => host.close());

  it('provisions atomically — owner served and enforcement flipped to local in one unit', async () => {
    expect(await probe()).toBe(true);
    expect(await permissionSource(s)).toBe('local');
  });

  it('reproduces the lockout: with the owner grant revoked, every check denies', async () => {
    // A scope-DO storage wipe leaves role defs projected + source = 'local' but no principal→role
    // tuple. Tombstoning the owner grant is that exact state — the scope enforces against nothing.
    await rawStub(s).revokeTuple(`principal:${owner}`, `role:office-admin`, `scope:${s}`, new Date().toISOString());
    expect(await probe()).toBe(false);
  });

  it('a reconcile (re-provision with the owner the vertical still knows) restores access', async () => {
    await provision(s); // what the builder-triggered /internal/reconcile does after reading owner_of_record
    expect(await probe()).toBe(true);
  });

  it('applyProjection refuses to switch on strict enforcement against an empty tuple table', async () => {
    const fresh = scopeId.parse(ulid());
    const roleDef = { role_key: 'office-admin', permissions: JSON.stringify([ADMIN]), source: 'vertical' };
    // Roles projected but nobody holds one → the flip is refused (else every check fails closed).
    await rawStub(fresh).applyProjection(t, [roleDef], []);
    expect(await permissionSource(fresh)).toBeUndefined();
    // The same projection carrying the owner grant in the same unit → now safe, and it flips.
    await rawStub(fresh).applyProjection(t, [roleDef], [], undefined, [
      { subject: `principal:${owner}`, relation: 'role:office-admin', object: `scope:${fresh}`, expires_at: null },
    ]);
    expect(await permissionSource(fresh)).toBe('local');
  });
});
