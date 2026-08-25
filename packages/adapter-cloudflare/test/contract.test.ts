import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { warmControlPlane } from './do-warmup.js';
import {
  connectionId,
  errorCodeOf,
  toProblem,
  moduleId,
  orgId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type EntitlementGrant,
  type ScopeTable,
} from '@substrat-run/contracts';
import { PermissionDenied, ulid, UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import {
  atomicContractSuite,
  billedMod,
  connectorTestFetch,
  permissionContractSuite,
  scheduleContractSuite,
  scheduleMod,
  scopeHostContractSuite,
  searchContractSuite,
  entityVersionContractSuite,
  timelineContractSuite,
  concurrencyContractSuite,
  idempotencyContractSuite,
  listContractSuite,
  permMod,
  inputParseContractSuite,
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

// #770: sub-transactions, on the default tuple checker (the K-34 assertion needs a
// real check to record). `atomicMod` is in `contractTestModules`, so the ScopeDO
// already carries it at code time — a DO cannot be handed handlers over RPC.
atomicContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

// The schedule suite (#383) also runs against the default tuple checker — it must
// resolve the projected system grant, not an allow-all.
scheduleContractSuite('adapter-cloudflare', async () => {
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
 * Scope-local permissions, Phase 1 (docs/architecture/scope-local-permissions.md): the
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

  it('projects a connection\'s PUBLIC sealing key, and a scope seals to it (#687)', async () => {
    // The whole carrier on the DO adapter, end to end: the platform mints the
    // keypair in the directory, projects only the public half into the scope, module
    // code seals to it without any control-plane binding, and the connector opens the
    // envelope with a private half that never left the directory.
    //
    // This is the shape a hosted vertical runs — the scope reads its own storage and
    // nothing else — and it is the only way a scope can hand a connector a value the
    // spine must not carry in the clear.
    const conn = connectionId.parse(ulid());
    await host.admin.createConnection(staff, {
      id: conn,
      tenantId: t,
      vertical: 'perm-vertical',
      provider: 'sealed-provider',
      label: 'Sealed provider',
      secret: { accessToken: 'tok' },
      scopes: [],
    });
    // Any tenant-level write fans out; this is the explicit form of the same thing.
    await host.reconcileTenantProjection(t);

    const scope = await host.getScope(alice, t, s1);
    const sealed = await scope.invoke<{ keyId: string; ciphertext: string }>(
      'perm/seal-to-connection',
      { provider: 'sealed-provider', plaintext: 'anna@kund.se' },
    );
    // It names the key that opens it — a cell that cannot is a cell that can never
    // be rotated retroactively.
    expect(sealed.keyId).toContain(conn);
    expect(sealed.ciphertext).not.toContain('anna@kund.se');

    // And only the private half opens it, from where a connector runs.
    const opened = await host.admin.connectionSealingKey(conn);
    expect(opened.keyId).toBe(sealed.keyId);
    let unsealed: string | undefined;
    host.registerConnector('sealed-reader', 'perm.acted', async (ctx) => {
      const c = await ctx.connection('sealed-provider');
      unsealed = await c.unseal(sealed);
    });
    // Any emit will do — what is under test is the connector's side of the seam,
    // reached the way every connector is reached: a delivered event.
    await scope.invoke('perm/authorized-emit', { permission: ADMIN });
    await host.drainDue(t, s1);
    expect(unsealed).toBe('anna@kund.se');
  });

  it('refuses to seal for a provider whose key never reached the scope (#687)', async () => {
    // The deploy-order hazard, fail-closed: between projecting a key and the vertical
    // asking for one, a request must break loudly rather than emit with the value
    // silently dropped — which is the invisible failure the carrier exists to end.
    const scope = await host.getScope(alice, t, s1);
    await expect(
      scope.invoke('perm/seal-to-connection', { provider: 'never-connected', plaintext: 'x' }),
    ).rejects.toThrow(/no 'never-connected' sealing key is available/);
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
 * #461: declared schedules must run on a CP-less host. Two seams, both pinned here:
 * `provisionScopeLocal` projects the `system:<moduleId>` grants (the CP-less mirror of
 * `provisionScope`'s loop — without it the grant-is-the-switch check reports `fired: 0`
 * forever, indistinguishable from "nothing due"), and `runDueSchedules` runs without
 * the directory liveness read a CP-less host cannot answer.
 */
describe('CP-less schedules — declared schedules run without a control plane (#461)', () => {
  let host: CloudflareScopeHost;
  const SCHED = moduleId.parse('@test/sched');
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  const READ = permissionKey.parse('perm:read');

  beforeAll(async () => {
    // No `controlPlane` — the null-object stand-in, exactly the hosted-vertical shape.
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    host.registerModule(scheduleMod);
    await host.provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [READ], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
  });

  afterAll(async () => host.close());

  it('fires the due schedule from the projected grant alone — no directory, no error', async () => {
    const report = await host.runDueSchedules(SCHED, t, s);
    expect(report.errors).toEqual([]);
    expect(report.fired).toBe(1);
    // The tick really landed in the scope, attributed to the module, not a person.
    const stub = await host.getScope(owner, t, s);
    expect(await stub.invoke('sched/count')).toBe(1);
    const outbox = (await stub.invoke('sched/read-outbox')) as { type: string; actor: string }[];
    const tick = outbox.find((r) => r.type === 'sched.ticked');
    expect(tick).toBeDefined();
    expect(JSON.parse(tick!.actor)).toEqual({ system: '@test/sched' });
  });

  it('cadence still gates the second pass — skipped, not re-fired', async () => {
    const report = await host.runDueSchedules(SCHED, t, s);
    expect(report.fired).toBe(0);
    expect(report.skipped).toBe(1);
  });

  it('ctx.check stays the gate — the system door is refused an unscheduled permission', async () => {
    // `sched:admin` is declared but never scheduled, so the projection grants the
    // system principal `sched:tick` only — same lever as the CP-full suite.
    const sys = await host.getSystemScope(SCHED, t, s);
    await expect(sys.invoke('sched/needs-admin')).rejects.toThrow();
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
 * #406: identity links ride the tenant projection, so a scope resolves
 * `(provider, externalId) → principal` from its OWN storage — the runtime identity
 * directory a CP-less vertical never had (its alternative was a login map compiled
 * into the bundle: offboarding by deploy, revocation undone by version rollback).
 * Two delivery paths, both asserted here: the CP-full fan-out on link/unlink, and
 * the CP-less delivery WITH provisioning (#310's channel).
 */
describe('identity-link projection — logins resolve scope-locally (#406)', () => {
  const staff = platformActorId.parse(ulid());
  const PROVIDER = 'oidc:authhero-test';

  describe('CP-full: link/unlink fan out into the tenant’s scopes', () => {
    let host: CloudflareScopeHost;
    const t = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const s2 = scopeId.parse(ulid());
    const erin = principalId.parse(ulid());

    beforeAll(async () => {
      host = new CloudflareScopeHost({
        scope: env.SCOPE,
        controlPlane: env.CONTROL_PLANE,
        secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
        scopeLocalPermissions: true,
      });
      await host.admin.createTenant(staff, { id: t, slug: `id-${t.toLowerCase()}`, name: 'Id Co' });
      await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
      for (const s of [s1, s2]) {
        await host.provisionScope(staff, { tenantId: t, scopeId: s });
        await host.admin.activateScope(staff, t, s);
      }
    });

    afterAll(async () => host.close());

    it('a link lands in every scope of the tenant; an unknown login stays undefined', async () => {
      await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: 'sub-erin', principal: erin, tenantId: t });
      expect((await host.resolveIdentityLocal(t, s1, PROVIDER, 'sub-erin'))?.principal).toBe(erin);
      expect((await host.resolveIdentityLocal(t, s2, PROVIDER, 'sub-erin'))?.principal).toBe(erin);
      expect(await host.resolveIdentityLocal(t, s1, PROVIDER, 'sub-nobody')).toBeUndefined();
    });

    it('an unlink fans out — the severed login stops resolving everywhere, durably', async () => {
      await host.admin.unlinkIdentity(staff, t, erin);
      expect(await host.resolveIdentityLocal(t, s1, PROVIDER, 'sub-erin')).toBeUndefined();
      expect(await host.resolveIdentityLocal(t, s2, PROVIDER, 'sub-erin')).toBeUndefined();
      // …and listIdentityLinks (the delivery gather) agrees with the projection.
      expect(await host.admin.listIdentityLinks(staff, t)).toHaveLength(0);
    });

    it('reconcileTenantProjection repairs a scope whose identity projection drifted', async () => {
      await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: 'sub-erin', principal: erin, tenantId: t });
      // Simulate a dropped fan-out: wipe s2's identity projection directly.
      const stub = env.SCOPE.get(env.SCOPE.idFromName(s2)) as unknown as {
        applyProjection(
          tenantId: string,
          roles: unknown[],
          tuples: unknown[],
          entitlements?: unknown[],
          scopeTuples?: unknown[],
          identities?: unknown[],
        ): Promise<void>;
      };
      await stub.applyProjection(t, [], [], undefined, undefined, []);
      expect(await host.resolveIdentityLocal(t, s2, PROVIDER, 'sub-erin')).toBeUndefined(); // stale → deny
      await host.reconcileTenantProjection(t);
      expect((await host.resolveIdentityLocal(t, s2, PROVIDER, 'sub-erin'))?.principal).toBe(erin); // repaired
    });
  });

  describe('CP-less: links delivered WITH provisioning, preserved across re-provision', () => {
    let host: CloudflareScopeHost;
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const owner = principalId.parse(ulid());
    const frank = principalId.parse(ulid());
    const READ = permissionKey.parse('perm:read');

    const provision = (identityLinks?: { provider: string; externalId: string; principal: typeof owner; scopeId?: typeof s }[]) =>
      host.provisionScopeLocal({
        tenantId: t,
        scopeId: s,
        owner,
        roles: [{ key: 'office-admin', permissions: [READ], source: 'vertical' }],
        ownerRoleKey: 'office-admin',
        identityLinks,
      });

    beforeAll(async () => {
      // No `controlPlane` — the null-object stand-in; the ONLY identity source is the projection.
      host = new CloudflareScopeHost({
        scope: env.SCOPE,
        secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      });
    });

    afterAll(async () => host.close());

    it('resolves a delivered link from the scope alone — tenant-level and scope-homed', async () => {
      await provision([
        { provider: PROVIDER, externalId: 'sub-owner', principal: owner },
        { provider: PROVIDER, externalId: 'sub-frank', principal: frank, scopeId: s },
      ]);
      const ownerHit = await host.resolveIdentityLocal(t, s, PROVIDER, 'sub-owner');
      expect(ownerHit?.principal).toBe(owner);
      expect(ownerHit?.scopeId).toBeNull(); // tenant-level home
      const frankHit = await host.resolveIdentityLocal(t, s, PROVIDER, 'sub-frank');
      expect(frankHit?.principal).toBe(frank);
      expect(frankHit?.scopeId).toBe(s); // scope-homed
    });

    it('a re-provision WITHOUT identityLinks preserves them (preserve-on-undefined)', async () => {
      await provision(); // e.g. an older platform re-running the idempotent provision
      expect((await host.resolveIdentityLocal(t, s, PROVIDER, 'sub-owner'))?.principal).toBe(owner);
    });

    it('a re-delivery with the link REMOVED stops it resolving — offboarding without a deploy', async () => {
      await provision([{ provider: PROVIDER, externalId: 'sub-owner', principal: owner }]);
      expect(await host.resolveIdentityLocal(t, s, PROVIDER, 'sub-frank')).toBeUndefined();
      expect((await host.resolveIdentityLocal(t, s, PROVIDER, 'sub-owner'))?.principal).toBe(owner);
    });
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

// ---------------------------------------------------------------------------
// Appended LAST on purpose. `runPlatformSweep` in the schedule suite above is
// platform-WIDE, so a scope provisioned by any earlier-running file lands in its
// report and turns its `errors` assertion red. Ordering inside one file is
// deterministic; ordering between files is not — so these live here rather than in
// a file of their own.
// ---------------------------------------------------------------------------
/**
 * What an operation failure carries out of the ScopeDO — measured against workerd,
 * because the comment that used to describe it was wrong twice.
 *
 * Every other error test in the repo runs in one isolate, where the class survives and
 * `instanceof` works. That is exactly why the production bug (`instanceof
 * PermissionDenied` false on the Cloudflare adapter, forcing verticals to regex the
 * message) stayed invisible: nothing crossed the hop in a test.
 *
 * The measurement that settled the design: a THROW carries its message and nothing
 * else. `name` is not a second channel — setting it folds it into the message as
 * `"<name>: <message>"` and resets `name` to `'Error'`. So a failure crosses as a
 * VALUE now (#113 §3): the DO returns `{ failure }` and the coordinator rethrows a
 * rebuilt error, which is the only shape that keeps the code and its extensions.
 */
describe('what an operation failure carries across the ScopeDO boundary', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const nobody = principalId.parse(ulid()); // holds no role anywhere
  const PERM_USE = permissionKey.parse('perm:use');

  let host: CloudflareScopeHost;

  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    host.registerModule(permMod);
    await host.admin.createTenant(staff, {
      id: t,
      slug: `taxonomy-${ulid().toLowerCase().slice(0, 8)}`,
      name: 'Taxonomy',
    });
    await host.admin.grantEntitlement(staff, t, 'perm');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, s);
  });

  const refused = async (): Promise<Error> => {
    const stub = await host.getScope(nobody, t, s);
    return stub.invoke('perm/authorized-emit', { permission: PERM_USE }).then(
      () => {
        throw new Error('the invoke should have been refused');
      },
      (err: Error) => err,
    );
  };

  it('delivers the message verbatim, with no class name folded into it', async () => {
    const err = await refused();
    expect(err.message).toBe('permission denied: perm:use');
    // The shapes a message-encoded carrier would leave behind. Either one reaching here
    // means every log line and UI string on this path just changed.
    expect(err.message).not.toMatch(/^PermissionDenied:/);
    expect(err.message).not.toContain('Substrat.');
  });

  // The whole point of the envelope, and the production bug it closes.
  it('delivers the code and the name, which a throw could not', async () => {
    const err = await refused();
    expect(errorCodeOf(err)).toBe('permission_denied');
    expect(err.name).toBe('PermissionDenied');
  });

  it('classifies to the same status a same-isolate throw would', async () => {
    const err = await refused();
    // A transport no longer has to know the class to get here — which is what lets
    // `vertical-host` stop matching on message text (its own suite covers that end).
    expect(toProblem(err).status).toBe(403);
  });

  // Deliberately still false, and documented as such: contracts cannot import the
  // kernel, so the rebuilt error is a SubstratError wearing the original name. Every
  // consumer in the repo reads the code or the name; none reads the constructor.
  it('does not resurrect the original class, and does not need to', async () => {
    const err = await refused();
    expect(err instanceof PermissionDenied).toBe(false);
    expect(err).toBeInstanceOf(Error);
  });

  /**
   * The compat claim, exercised.
   *
   * Everything above goes through the coordinator, which always asks for the envelope —
   * so without this, the `failureEnvelope`-absent branch is reached by no test at all,
   * and the argument that makes this change safe to deploy ("an old ScopeDO ignores the
   * flag and throws exactly as it always did") would be an assertion about code nothing
   * runs. This calls the DO directly, the way an older coordinator would.
   */
  describe('a caller that does not ask for the envelope', () => {
    const rawInvoke = (scope: string) =>
      env.SCOPE.get(env.SCOPE.idFromName(scope)) as unknown as {
        invoke(
          operation: string,
          input: unknown,
          principal: string,
          tenantId: string,
          scopeId: string,
          connectionId?: string,
          requiredEntitlement?: string,
          systemModuleId?: string,
          failureEnvelope?: boolean,
        ): Promise<{ result: unknown; platformRequests: number; failure?: unknown }>;
      };

    it('still gets a throw, and a message it can still match on', async () => {
      const thrown = await rawInvoke(s)
        .invoke('perm/authorized-emit', { permission: PERM_USE }, nobody, t, s)
        .then(
          () => undefined,
          (err: Error) => err,
        );

      expect(thrown, 'the legacy path must reject, never resolve').toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe('permission denied: perm:use');
    });

    it('never receives a failure smuggled into a resolved result', async () => {
      // The dangerous skew, ruled out: an older coordinator reads `.result` off the
      // resolved value. If the DO answered with an envelope here, a denial would read
      // as a successful operation returning undefined.
      const settled = await rawInvoke(s)
        .invoke('perm/authorized-emit', { permission: PERM_USE }, nobody, t, s)
        .then(
          (value) => ({ resolved: true as const, value }),
          () => ({ resolved: false as const }),
        );
      expect(settled.resolved).toBe(false);
    });

    it('answers the envelope only when it is asked to', async () => {
      const envelope = await rawInvoke(s).invoke(
        'perm/authorized-emit',
        { permission: PERM_USE },
        nobody,
        t,
        s,
        undefined,
        undefined,
        undefined,
        true,
      );
      expect(envelope.failure).toBeDefined();
      expect(envelope.result).toBeUndefined();
    });
  });
});

// #827: the derived FTS index, on the substrate where it is least obvious that it
// works. Durable Object SQLite ships FTS5, but it also runs every statement past a
// regulator that decides whether a trigger may fire at all — so "it works in
// better-sqlite3" is not evidence about this host, and this suite is the evidence.
searchContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    checker: UNSAFE_allowAllChecker,
  });
  return { host, cleanup: async () => host.close() };
});

// #901: the entity-version read on the DO host. The query is ordinary SQL, but
// the index behind it is spine DDL that workerd's regulator has to permit — the
// same reason every other derived-DDL suite runs on both hosts.
entityVersionContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    checker: UNSAFE_allowAllChecker,
  });
  return { host, cleanup: async () => host.close() };
});

// #800: the supported read of an entity's history. The DEFAULT checker, because
// the history half asserts K-34 `authorization` — the checks the emitting
// operation passed — and an allow-all cannot answer a real `ctx.check` at all
// (it interpolates the subject, which is a structured actor).
timelineContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      });
  return { host, cleanup: async () => host.close() };
});

// #811: `ctx.page` on the DO host — same suite, and the only place the derived
// index DDL meets workerd's regulator.
listContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    checker: UNSAFE_allowAllChecker,
  });
  return { host, cleanup: async () => host.close() };
});

// #893: the declared `input` parsed at the door, on the adapter that is actually
// deployed. The DEFAULT tuple checker — the fixture's handlers run a real
// `ctx.check`, which an allow-all cannot answer. `parseMod` is in
// `contractTestModules`, so the ScopeDO carries it at code time.
inputParseContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

// #129: optimistic concurrency on the DO host, and the DEFAULT checker. This is
// the only place the precondition is proven to cross the coordinator↔ScopeDO hop:
// the comparison happens inside the DO's transaction, and the acknowledgement has
// to come back or the coordinator refuses the success.
concurrencyContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

// #116: request idempotency on the DO host. The only place the recording is
// proven to live inside the DO's own transaction and the acknowledgement to
// cross the coordinator↔ScopeDO hop — a DO that dropped the key would EXECUTE
// the operation again, which is the failure the header was sent to prevent.
idempotencyContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});
