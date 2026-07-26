import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { warmControlPlane } from './do-warmup.js';
import { orgId, permissionKey, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import {
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
