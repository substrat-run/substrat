// The contract suites on the DO path, part 1 of 3: the scope host, its directory and the doors to it —
// audit transactions, version skew, stores, roles and reserved keys, permissions, impersonation,
// capabilities and invites. Parts 2 and 3 are contract-switch.test.ts and contract-data.test.ts; CI
// runs each on its own shard (tools/ci-scope.mjs PARTS).
import { env, runInDurableObject } from 'cloudflare:test';
import { effectiveRoleGrantQuery } from '@substrat-run/kernel';
import { createLocalControlPlaneReader } from '../src/checker.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { warmControlPlane, warmSwitchHolds } from './do-warmup.js';
import { seedProjectedRole, tombstoneProjectedRole } from './seed-projection.js';
import {
  connectionId,
  errorCodeOf,
  toWireFailure,
  instant,
  moduleId,
  orgId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  storeDriverReleaseDigest,
  tenantId,
  type EntityRef,
  type MintedCapability,
  type RoleDefinition,
  type ScopeId,
} from '@substrat-run/contracts';
import { capabilityTokenHash, ulid, UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import {
  atomicContractSuite,
  capabilityContractSuite,
  capMod,
  becomeMintContractSuite,
  bindingInviteContractSuite,
  impersonationContractSuite,
  inertScopeContractSuite,
  unreadableScopeRowContractSuite,
  storedVerticalCopyContractSuite,
  storeDriverReleaseContractSuite,
  connectLinkContractSuite,
  causedByContractSuite,
  scopeCausedByContractSuite,
  membershipExecutorContractSuite,
  findingsContractSuite,
  scopeStoreContractSuite,
  findingsAtomicContractSuite,
  connectorTestFetch,
  permissionContractSuite,
  reservedRoleContractSuite,
  roleStateContractSuite,
  restoreRoleContractSuite,
  adminActionFaultSql,
  scopeAdminAuditTransactionSuite,
  scopePermissionAuditSuite,
  directoryAdminAuditTransactionSuite,
  scopeHostContractSuite,
} from '@substrat-run/contract-tests';
import { CloudflareScopeHost, type ConnectorDelegation } from './test-host.js';
import { ControlPlaneDO } from '../src/control-plane-do.js';
import { approveStoredDriverRelease, storeReleaseKey } from '@substrat-run/control-plane-api';

// Absorb the inter-file DO reload before any suite's first directory call
// (see do-warmup.ts) — file-level, so it runs before every suite below.
beforeAll(() => warmControlPlane(env.CONTROL_PLANE));
// …and the #1819 hold object every schedule pass over SCOPE reads.
beforeAll(() => warmSwitchHolds(env.SCOPE));

// The scope-host suite runs against an allow-all checker (it exercises no
// ctx.check). Runtime module registration is unsupported on CF — the ScopeDO
// closes over a code-time module set — so that one late-registration test is
// skipped; every other test is shared unchanged (D-14).
scopeAdminAuditTransactionSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
  return {
    host,
    refuseAdminAction: async (scope: string, action: string) => {
      const { create, drop } = adminActionFaultSql(scope, action);
      await runInDurableObject(env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')),
        (_, state) => { state.storage.sql.exec(create); });
      return async () => runInDurableObject(env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')),
        (_, state) => { state.storage.sql.exec(drop); });
    },
    cleanup: async () => host.close(),
  };
});

scopePermissionAuditSuite('adapter-cloudflare', async () => {
  let countScopeStubGets = false;
  let scopeStubGets = 0;
  const trackedScope = {
    idFromName: (name: string) => env.SCOPE.idFromName(name),
    get: (id: DurableObjectId) => {
      if (countScopeStubGets) scopeStubGets++;
      return env.SCOPE.get(id);
    },
  } as typeof env.SCOPE;
  const host = new CloudflareScopeHost({ scope: trackedScope, controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
  const directory = (sql: string) => runInDurableObject(env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')),
    (_, state) => { state.storage.sql.exec(sql); });
  const scopeState = (scope: string, sql: string) => runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)),
    (_, state) => state.storage.sql.exec(sql));
  return {
    host,
    directoryExec: async (sql: string) => { await directory(sql); },
    scopeExec: async (_tenant: string, scope: string, sql: string) => { await scopeState(scope, sql); },
    scopeCount: async (_tenant: string, scope: string, sql: string) => runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)),
      (_, state) => (state.storage.sql.exec(sql).toArray()[0] as { n: number }).n),
    prepareOldScopeForIntentFault: async (_tenant: string, scope: string) => {
      await runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_, state) => {
        state.storage.sql.exec('ALTER TABLE _substrat_capabilities DROP COLUMN attachments');
        if (state.storage.sql.exec("SELECT name FROM pragma_table_info('_substrat_capabilities') WHERE name = 'attachments'").toArray().length) {
          throw new Error('the old scope still has the attachments column');
        }
      });
      await runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_, state) => {
        state.abort('reopen old scope for intent fault');
      }).catch(() => undefined);
      scopeStubGets = 0;
      countScopeStubGets = true;
    },
    oldScopeStayedUnmigrated: async () => {
      countScopeStubGets = false;
      // A cold DO cannot migrate unless the coordinator obtains a stub to wake it.
      return scopeStubGets === 0;
    },
    cleanup: async () => host.close(),
  };
});

/** An admin-log row a host hands the ControlPlaneDO with the write it belongs to. */
const isAdminEntry = (a: unknown): boolean =>
  typeof a === 'object' && a !== null && 'action' in a && 'actor' in a && 'before' in a && 'after' in a;
/** Whether a call's arguments carry one, directly or inside a `reply`'s argument list. */
const carriesAdminEntry = (args: unknown[]): boolean =>
  args.some((a) => isAdminEntry(a) || (Array.isArray(a) && carriesAdminEntry(a)));

/**
 * #2528: the control-plane namespace with its stub wrapped, so `intercept` runs ahead of every
 * call the host makes; an answer it returns stands in for the DO's. Calls the stub's own method
 * on the stub (never a bound copy), and leaves `then` alone so the wrapper is not a thenable.
 */
function interceptedControlPlane(
  intercept: (args: unknown[], method: string) => Promise<{ answer: unknown } | void>,
): typeof env.CONTROL_PLANE {
  const ns = env.CONTROL_PLANE;
  return {
    idFromName: (name: string) => ns.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = ns.get(id) as unknown as Record<string, (...a: unknown[]) => unknown>;
      return new Proxy(stub, {
        get: (target, prop) => {
          if (typeof prop !== 'string' || prop === 'then') return Reflect.get(target, prop);
          return async (...args: unknown[]) => {
            const over = await intercept(args, prop);
            return over ? over.answer : target[prop]!(...args);
          };
        },
      });
    },
  } as unknown as typeof env.CONTROL_PLANE;
}

directoryAdminAuditTransactionSuite('adapter-cloudflare', async () => {
  const directorySql = async (sql: string) => runInDurableObject(env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')),
    (_, state) => { state.storage.sql.exec(sql); });
  // #2528: the armed statement commits on its own just before the next ControlPlaneDO call that
  // carries an admin entry, which is the call an audited write's unit runs in on this adapter.
  let armed: string | null = null;
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: interceptedControlPlane(async (args) => {
    if (armed === null || !carriesAdminEntry(args)) return;
    const sql = armed;
    armed = null;
    await directorySql(sql);
  }), secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  tenantStores: { create: async (name) => name, remove: async () => {}, query: async () => ({ results: [], changes: 0 }) } });
  return {
    host,
    directorySql,
    directoryRows: async (sql: string) => runInDurableObject(env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')),
      (_, state) => state.storage.sql.exec(sql).toArray()),
    interleave: (sql: string) => { armed = sql; },
    cleanup: async () => host.close(),
  };
});

describe('#2479: directory audit across a coordinator/DO version skew', () => {
  it('refuses an old DO that ignores a trailing audit argument before changing directory state', async () => {
    const staff = platformActorId.parse(ulid());
    const provider = `skew-${ulid().toLowerCase()}`;
    const reader = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
    const oldDo = interceptedControlPlane(async (args, method) => {
      if (method !== 'reply') return;
      const called = args[0] as string;
      if (called === 'registerIdentityPool') {
        // An old DO knows this method but accepts only its original four arguments.
        const cp = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')) as unknown as {
          reply(method: string, args: unknown[]): Promise<unknown>;
        };
        return { answer: await cp.reply(called, (args[1] as unknown[]).slice(0, 4)) };
      }
      if (called === 'registerIdentityPoolAndAudit') {
        return { answer: { failure: toWireFailure(new Error(`not a replied directory method: ${called}`)) } };
      }
    });
    const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: oldDo });
    try {
      const outcome = await host.admin.registerIdentityPool(staff, { provider, topology: 'central', tenantId: null })
        .then(() => 'accepted', (err: unknown) => err instanceof Error ? err.message : String(err));
      expect({ outcome, state: await reader.admin.getIdentityPool(staff, provider),
        rows: (await reader.admin.auditLog(staff, { action: ['registerIdentityPool'] }))
          .filter((row) => row.actor === staff) }).toEqual({
        outcome: 'not a replied directory method: registerIdentityPoolAndAudit', state: undefined, rows: [],
      });
    } finally {
      await host.close();
      await reader.close();
    }
  });

  it('keeps the old coordinator\'s bare method working so it can append its own row', async () => {
    const staff = platformActorId.parse(ulid());
    const provider = `skew-${ulid().toLowerCase()}`;
    const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
    const cp = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')) as unknown as {
      reply(method: string, args: unknown[]): Promise<{ value?: boolean; failure?: unknown }>;
      recordAdmin(entry: Record<string, unknown>): Promise<void>;
    };
    try {
      const at = new Date().toISOString();
      expect(await cp.reply('registerIdentityPool', [provider, 'central', null, at])).toEqual({ value: true });
      expect(await host.admin.getIdentityPool(staff, provider)).toBeDefined();
      const rows = async () => (await host.admin.auditLog(staff, { action: ['registerIdentityPool'] }))
        .filter((row) => row.actor === staff);
      expect(await rows()).toEqual([]);
      await cp.recordAdmin({ id: ulid(), actor: staff, action: 'registerIdentityPool', tenantId: null,
        scopeId: null, vertical: null, before: null, after: { provider, topology: 'central', tenantId: null },
        causedBy: null, onBehalfOf: null, at });
      expect(await rows()).toHaveLength(1);
    } finally {
      await host.close();
    }
  });
});

describe('#2527: scope permission audit across coordinator/ScopeDO version skew', () => {
  it('keeps the shared coordinator placeholder on its legacy single-row path and refuses hosted mint before intent', async () => {
    const staff = platformActorId.parse(ulid());
    const tenant = tenantId.parse(ulid());
    const scope = scopeId.parse(ulid());
    const principal = principalId.parse(ulid());
    const roleKey = `hosted-${ulid().toLowerCase()}`;
    const reader = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
    // A delegation marks this coordinator as shared; its SCOPE binding is the placeholder.
    const shared = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE,
      connectorDelegation: {} as ConnectorDelegation });
    try {
      await reader.admin.createTenant(staff, { id: tenant, slug: `hosted-${tenant.toLowerCase()}`, name: 'Hosted' });
      await reader.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'hosted' });
      await reader.admin.activateScope(staff, tenant, scope);
      await reader.admin.defineRole(staff, tenant, { key: roleKey, permissions: [permissionKey.parse('audit:read')], source: 'vertical' });
      await shared.admin.assignRole(staff, { principalId: principal, roleKey, node: { tenantId: tenant, scopeId: scope } });
      const rows = await reader.admin.auditLog(staff, { tenantId: tenant, scopeId: scope, action: 'assignRole' });
      expect(rows).toHaveLength(1);
      expect((rows[0]!.after as { phase?: string }).phase).toBeUndefined();
      await expect(shared.admin.mintCapability(staff, tenant, scope, { principal,
        expiresAt: new Date(Date.now() + 60_000).toISOString() as never, maxUses: 1 })).rejects.toThrow('cannot reach');
      expect(await reader.admin.auditLog(staff, { tenantId: tenant, scopeId: scope, action: 'mintCapability' })).toEqual([]);
    } finally {
      await shared.close();
      await reader.close();
    }
  });

  it('an older ScopeDO refuses the new tuple RPC before mutation; its old tuple RPC still serves old coordinators', async () => {
    const staff = platformActorId.parse(ulid());
    const tenant = tenantId.parse(ulid());
    const scope = scopeId.parse(ulid());
    const principal = principalId.parse(ulid());
    const roleKey = `skew-${ulid().toLowerCase()}`;
    const assignment = { principalId: principal, roleKey, node: { tenantId: tenant, scopeId: scope } };
    const reader = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
    const oldScope = {
      idFromName: (name: string) => env.SCOPE.idFromName(name),
      get: (id: DurableObjectId) => {
        const stub = env.SCOPE.get(id) as unknown as Record<string, (...args: unknown[]) => unknown>;
        return new Proxy(stub, { get: (target, prop) =>
          prop === 'writeTupleAndAuditIntent'
            ? async () => { throw new Error('unknown scope RPC: writeTupleAndAuditIntent'); }
            : Reflect.get(target, prop) });
      },
    } as unknown as typeof env.SCOPE;
    const coordinator = new CloudflareScopeHost({ scope: oldScope, controlPlane: env.CONTROL_PLANE });
    const count = () => runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_, state) =>
      (state.storage.sql.exec(`SELECT COUNT(*) AS n FROM _substrat_tuples WHERE subject = ? AND relation = ? AND object = ? AND revoked_at IS NULL`,
        `principal:${principal}`, `role:${roleKey}`, `scope:${scope}`).toArray()[0] as { n: number }).n);
    try {
      await reader.admin.createTenant(staff, { id: tenant, slug: `skew-${tenant.toLowerCase()}`, name: 'Skew' });
      await reader.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'skew' });
      await reader.admin.activateScope(staff, tenant, scope);
      await reader.admin.defineRole(staff, tenant, { key: roleKey, permissions: [permissionKey.parse('audit:read')], source: 'vertical' });
      await expect(coordinator.admin.assignRole(staff, assignment)).rejects.toThrow('unknown scope RPC');
      expect(await count()).toBe(0);
      const rows = () => reader.admin.auditLog(staff, { tenantId: tenant, scopeId: scope, action: 'assignRole' });
      expect((await rows()).map((row) => (row.after as { phase?: string }).phase)).toEqual(['intent']);

      const oldStub = env.SCOPE.get(env.SCOPE.idFromName(scope)) as unknown as {
        writeTuple(subject: string, relation: string, object: string, expiresAt: null): Promise<unknown>;
      };
      await oldStub.writeTuple(`principal:${principal}`, `role:${roleKey}`, `scope:${scope}`, null);
      expect(await count()).toBe(1);
      const cp = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')) as unknown as { recordAdmin(entry: Record<string, unknown>): Promise<void> };
      await cp.recordAdmin({ id: ulid(), actor: staff, action: 'assignRole', tenantId: tenant, scopeId: scope,
        vertical: null, before: null, after: assignment, causedBy: null, onBehalfOf: null, at: new Date().toISOString() });
      expect((await rows()).map((row) => (row.after as { phase?: string }).phase)).toEqual(['intent', undefined]);
    } finally {
      await coordinator.close();
      await reader.close();
    }
  });
});

/**
 * #2528 across a version skew. The coordinator and the ControlPlaneDO it calls ship together, but
 * a deploy can briefly pair either side with the other's previous release: the old coordinator's
 * calls must keep working against the new DO, and the new coordinator must fail closed, writing
 * nothing, against an old DO that does not know the methods it now calls through `reply`.
 */
describe('#2528: vertical directory writes across a coordinator/DO version skew', () => {
  const staff = platformActorId.parse(ulid());
  const cpStub = () => env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')) as unknown as {
    updateVerticalInstallsBlocked(slug: string, blocked: number, audit: unknown): Promise<void>;
    setAdmission(id: string, admission: string, note: string | null, audit: unknown): Promise<void>;
    setVerticalServing(slug: string, s: { ref: string; versionId: string; doClassesJson: string; migrationTag: string }, audit: unknown,
      expected?: { ref: string | null; versionId: string | null }): Promise<boolean>;
    deleteVertical(slug: string, audit: unknown, until?: string): Promise<void>;
    insertVersion(v: Record<string, unknown>, audit: unknown): Promise<void>;
  };
  /** The entry an old coordinator minted: its own `before`, read outside the write. */
  const entry = (action: string, before: unknown, after: unknown) => ({
    id: ulid(), actor: staff, action, tenantId: null, causedBy: null, onBehalfOf: null,
    scopeId: null, vertical: null, before, after, at: new Date().toISOString(),
  });
  const newHost = (controlPlane = env.CONTROL_PLANE) => new CloudflareScopeHost({ scope: env.SCOPE, controlPlane,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
  const registered = async (host: CloudflareScopeHost) => {
    const slug = `skew-${ulid().toLowerCase()}`;
    await host.admin.registerVertical(staff, { slug, name: 'Skew', source: 'builtin' });
    return slug;
  };
  const published = async (host: CloudflareScopeHost, slug: string) => {
    const id = ulid();
    await host.admin.publishVersion(staff, { id, verticalSlug: slug, version: `1.0.${id.toLowerCase()}`,
      manifestDigest: 'm', permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null });
    return id;
  };

  it('an old coordinator\'s direct calls still write, and their rows', async () => {
    const host = newHost();
    try {
      const cp = cpStub();
      const slug = await registered(host);
      const since = new Date().toISOString();
      await cp.updateVerticalInstallsBlocked(slug, 1,
        entry('setVerticalInstallsBlocked', { installsBlocked: false }, { installsBlocked: true }));
      expect((await host.admin.listVerticals(staff)).find((v) => v.slug === slug)?.installsBlocked).toBe(true);

      const version = await published(host, slug);
      await cp.setAdmission(version, 'admitted', null, entry('admitVersion', { admission: 'pending' }, { admission: 'admitted' }));
      expect((await host.admin.getVersion(staff, version))?.admission).toBe('admitted');

      // No expected serving version: the write is unconditional, as it was.
      await expect(cp.setVerticalServing(slug, { ref: 'skew-serving', versionId: version, doClassesJson: '[]', migrationTag: 'g' },
        entry('setVerticalServing', null, { vertical: slug, ref: 'skew-serving', versionId: version }))).resolves.toBe(true);
      expect((await host.admin.verticalServing(staff, slug))?.versionId).toBe(version);
      // #2577: a coordinator from #2528 expects the ref and version alone, and the class set and tag
      // it does not send are not compared.
      await expect(cp.setVerticalServing(slug, { ref: 'skew-serving', versionId: version, doClassesJson: '["ScopeDO"]', migrationTag: 'g2' },
        entry('setVerticalServing', null, { vertical: slug, ref: 'skew-serving', versionId: version }),
        { ref: 'skew-serving', versionId: version })).resolves.toBe(true);
      expect((await host.admin.verticalServing(staff, slug))?.migrationTag).toBe('g2');

      const old = ulid();
      await cp.insertVersion({ id: old, verticalSlug: slug, version: `1.0.${old.toLowerCase()}`, manifestDigest: 'm',
        permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null, admission: 'pending', admissionNote: null,
        manifestJson: null, originJson: null, migrations: null, createdAt: new Date().toISOString() },
      entry('publishVersion', null, { id: old, admission: 'pending' }));
      expect((await host.admin.getVersion(staff, old))?.admission).toBe('pending');

      const gone = await registered(host);
      await cp.deleteVertical(gone, entry('deleteVertical', { slug: gone, source: 'builtin', ownerTenant: null }, null), instant.parse(new Date().toISOString()));
      expect((await host.admin.listVerticals(staff)).find((v) => v.slug === gone)).toBeUndefined();

      const rows = await host.admin.auditLog(staff, {
        action: ['setVerticalInstallsBlocked', 'admitVersion', 'setVerticalServing', 'publishVersion', 'deleteVertical'], since,
      });
      expect(rows.filter((r) => r.actor === staff).map((r) => [r.action, r.before])).toEqual(expect.arrayContaining([
        ['setVerticalInstallsBlocked', { installsBlocked: false }],
        ['admitVersion', { admission: 'pending' }],
        ['setVerticalServing', null],
        ['deleteVertical', { slug: gone, source: 'builtin', ownerTenant: null }],
      ]));
    } finally {
      await host.close();
    }
  });

  // #2565: an old coordinator moves a channel with `moveChannel`, which judged no listing. The new
  // DO has none, so that call is refused by the RPC layer before anything runs.
  it('#2565: an old coordinator\'s channel move finds no method on the new DO', () => {
    expect('moveChannel' in ControlPlaneDO.prototype).toBe(false);
  });

  // What a DO from before this change answers for a method it does not list (`reply`).
  const NEW_REPLIED = ['updateVerticalListed', 'updateVerticalPublishRequest', 'updateVerticalInstallsBlocked',
    'updateVerticalTenantProvisioner', 'updateVerticalEmailSender', 'deleteVertical', 'admitVersion', 'rejectVersion',
    'setVerticalServing', 'promoteChannel'];
  const oldDo = () => interceptedControlPlane(async (args, method) => {
    if (method !== 'reply' || !NEW_REPLIED.includes(args[0] as string)) return;
    return { answer: { failure: toWireFailure(new Error(`not a replied directory method: ${String(args[0])}`)) } };
  });

  it('a new coordinator against an old DO fails closed, naming the method, and writes nothing', async () => {
    const reader = newHost();
    const host = newHost(oldDo());
    try {
      const slug = await registered(reader);
      const version = await published(reader, slug);
      const admitted = await published(reader, slug);
      // Another actor, so its row is not the one the assertion below counts, even in the same millisecond.
      await reader.admin.admitVersion(platformActorId.parse(ulid()), admitted);
      const since = new Date().toISOString();
      // #2565: the promote's channel move, which judges the vertical's listing in its unit.
      await expect(host.admin.promoteVersion(staff, slug, 'prod', admitted)).rejects.toThrow('not a replied directory method: promoteChannel');
      expect(await reader.admin.listChannels(staff, slug)).toEqual([]);
      await expect(host.admin.setVerticalInstallsBlocked(staff, slug, true))
        .rejects.toThrow('not a replied directory method: updateVerticalInstallsBlocked');
      await expect(host.admin.setVerticalListed(staff, slug, true))
        .rejects.toThrow('not a replied directory method: updateVerticalListed');
      await expect(host.admin.admitVersion(staff, version)).rejects.toThrow('not a replied directory method: admitVersion');
      await expect(host.admin.deleteVertical(staff, slug)).rejects.toThrow('not a replied directory method: deleteVertical');
      await expect(host.admin.setVerticalServing(staff, slug, { ref: 'skew', versionId: version, doClasses: [], migrationTag: 'g' }))
        .rejects.toThrow('not a replied directory method: setVerticalServing');
      const v = (await reader.admin.listVerticals(staff)).find((r) => r.slug === slug);
      expect(v).toMatchObject({ installsBlocked: false, listed: false });
      expect((await reader.admin.getVersion(staff, version))?.admission).toBe('pending');
      expect(await reader.admin.verticalServing(staff, slug)).toBeNull();
      expect((await reader.admin.auditLog(staff, { since })).filter((r) => r.actor === staff)).toEqual([]);
      // Its twin: the same host's calls the old DO does list still go through.
      await expect(host.admin.publishVersion(staff, { id: ulid(), verticalSlug: slug, version: `1.0.${ulid().toLowerCase()}`,
        manifestDigest: 'm', permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null })).resolves.toBeUndefined();
    } finally {
      await host.close();
      await reader.close();
    }
  });
});

/**
 * #2526: the role, grant and org writes at a tenant node, across the same skew. An old coordinator
 * calls the DO's methods directly, without a row, and records its own; the new coordinator calls
 * each through `reply`, which an old DO refuses for a method it does not list, writing nothing.
 */
describe('#2526: role, grant and org writes across a coordinator/DO version skew', () => {
  const staff = platformActorId.parse(ulid());
  const AUDIT_READ = permissionKey.parse('audit:read');
  const cpStub = () => env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')) as unknown as {
    defineRoleOrRefusal(tenantId: string, role: unknown, reservation: unknown, seatedInScopes: boolean): Promise<{ before: unknown } | { refused: string }>;
    writeTenantTuple(tenantId: string, subject: string, relation: string, object: string, expiresAt: string | null): Promise<void>;
    writeTenantSystemGrant(tenantId: string, moduleId: string, relation: string, expiresAt: string | null): Promise<string[]>;
    createOrg(orgId: string, tenantId: string, slug: string, name: string, createdAt: string): Promise<boolean>;
    recordConnectionGrant(row: Record<string, unknown>): Promise<void>;
  };
  const newHost = (controlPlane = env.CONTROL_PLANE) => new CloudflareScopeHost({ scope: env.SCOPE, controlPlane,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
  const tuples = async (t: string) => runInDurableObject(env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')),
    (_, state) => state.storage.sql.exec('SELECT subject, relation FROM _substrat_tenant_tuples WHERE tenant_id = ? AND revoked_at IS NULL', t).toArray());
  const newTenant = async (host: CloudflareScopeHost) => {
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `skew-${ulid().toLowerCase()}`, name: 'Skew' });
    return t;
  };

  it('an old coordinator\'s direct calls still write, without a row of their own', async () => {
    const host = newHost();
    try {
      const cp = cpStub();
      const t = await newTenant(host);
      const since = new Date().toISOString();
      await expect(cp.defineRoleOrRefusal(t, { key: 'auditor', permissions: [AUDIT_READ], source: 'vertical' }, { reserved: [], declared: [] }, false))
        .resolves.toEqual({ before: null });
      await cp.writeTenantTuple(t, 'principal:p1', `granted:${AUDIT_READ}`, `tenant:${t}`, null);
      await expect(cp.writeTenantSystemGrant(t, 'skew-module', `granted:${AUDIT_READ}`, null)).resolves.toEqual([]);
      const org = orgId.parse(ulid());
      await expect(cp.createOrg(org, t, `skew-${ulid().toLowerCase()}`, 'Skew org', since)).resolves.toBe(true);
      await cp.recordConnectionGrant({ connectionId: ulid(), tenantId: t, vertical: 'skew', permission: AUDIT_READ, scopeId: null,
        expiresAt: null, grantedBy: staff, grantedAt: since });
      expect((await host.admin.listRoles(staff, { tenantId: t })).map((r) => r.key)).toEqual(['auditor']);
      expect(await tuples(t)).toEqual(expect.arrayContaining([
        { subject: 'principal:p1', relation: `granted:${AUDIT_READ}` },
        { subject: 'system:skew-module', relation: `granted:${AUDIT_READ}` },
      ]));
      expect(await host.admin.getOrg(staff, t, org)).toBeDefined();
      expect(await host.admin.listConnectionGrants(staff, t)).toHaveLength(1);
      // The old coordinator records its own rows; the DO wrote none for it.
      expect(await host.admin.auditLog(staff, { tenantId: t, since, action: ['defineRole', 'grant', 'grantToSystem', 'createOrg', 'grantToConnection'] }))
        .toEqual([]);
    } finally {
      await host.close();
    }
  });

  const NEW_REPLIED = ['defineRoleOrRefusal', 'assignTenantRole', 'writeTenantTuple', 'writeOrgTenantTuple', 'writeTenantSystemGrant',
    'grantConnectionInDirectory', 'insertOrg'];
  const oldDo = () => interceptedControlPlane(async (args, method) => {
    if (method !== 'reply' || !NEW_REPLIED.includes(args[0] as string)) return;
    return { answer: { failure: toWireFailure(new Error(`not a replied directory method: ${String(args[0])}`)) } };
  });

  it('a new coordinator against an old DO fails closed, naming the method, and writes nothing', async () => {
    const reader = newHost();
    const host = newHost(oldDo());
    try {
      const t = await newTenant(reader);
      const org = orgId.parse(ulid());
      await reader.admin.createOrg(staff, { id: org, tenantId: t, slug: `skew-${ulid().toLowerCase()}`, name: 'Skew org' });
      await reader.admin.defineRole(staff, t, { key: 'auditor', permissions: [AUDIT_READ], source: 'vertical' });
      const conn = connectionId.parse(ulid());
      await reader.admin.createConnection(staff, { id: conn, tenantId: t, vertical: 'skew', provider: `skew-${conn.toLowerCase()}`,
        label: 'Skew', secret: { accessToken: 'tok' } });
      const node = { tenantId: t, scopeId: null };
      const who = principalId.parse(ulid());
      const since = new Date().toISOString();
      const refused: [Promise<unknown>, string][] = [
        [host.admin.defineRole(staff, t, { key: 'other', permissions: [AUDIT_READ], source: 'vertical' }), 'defineRoleOrRefusal'],
        [host.admin.assignRole(staff, { principalId: who, roleKey: 'auditor', node }), 'assignTenantRole'],
        [host.admin.grant(staff, { principalId: who, permission: AUDIT_READ, node, grantedBy: who }), 'writeTenantTuple'],
        [host.admin.grantToOrg(staff, org, AUDIT_READ, node), 'writeOrgTenantTuple'],
        [host.admin.addMember(staff, t, who, org), 'writeOrgTenantTuple'],
        [host.admin.grantToSystem(staff, { moduleId: moduleId.parse('skew-module'), permission: AUDIT_READ, node, grantedBy: staff }), 'writeTenantSystemGrant'],
        [host.admin.grantToConnection(staff, { connectionId: conn, permission: AUDIT_READ, node, grantedBy: staff }), 'grantConnectionInDirectory'],
        [host.admin.createOrg(staff, { id: orgId.parse(ulid()), tenantId: t, slug: `skew-${ulid().toLowerCase()}`, name: 'New org' }), 'insertOrg'],
      ];
      for (const [call, method] of refused) await expect(call).rejects.toThrow(`not a replied directory method: ${method}`);
      expect((await reader.admin.listRoles(staff, { tenantId: t })).map((r) => r.key)).toEqual(['auditor']);
      expect(await tuples(t)).toEqual([]);
      expect(await reader.admin.listOrgs(staff, t)).toHaveLength(1);
      expect(await reader.admin.listConnectionGrants(staff, t)).toEqual([]);
      expect(await reader.admin.auditLog(staff, { tenantId: t, since,
        action: ['defineRole', 'assignRole', 'grant', 'grantToOrg', 'addMember', 'grantToSystem', 'grantToConnection'] }))
        .toEqual([]);
      // `createOrg` by its own: the arrange's org shares the `since` millisecond.
      expect((await reader.admin.auditLog(staff, { tenantId: t, action: ['createOrg'] }))).toHaveLength(1);
    } finally {
      await host.close();
      await reader.close();
    }
  });
});

/**
 * #2526: the hostname and entitlement writes, across the same skew. None of their DO methods was
 * a replied one before, so a trailing row is safe: an old coordinator calls them directly without
 * it and gets the bare write it always did (and the widened answers, which it ignores); the new
 * coordinator calls them through `reply`, which an old DO refuses, writing nothing.
 */
describe('#2526: hostname and entitlement writes across a coordinator/DO version skew', () => {
  const staff = platformActorId.parse(ulid());
  const cpStub = () => env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')) as unknown as {
    demoteCanonical(scopeId: string, surface: string): Promise<void>;
    upsertHostname(h: Record<string, unknown>): Promise<void>;
    setHostnameStatus(hostname: string, status: string, note: string | null): Promise<boolean>;
    setHostnameIssuance(hostname: string, fields: Record<string, unknown>): Promise<boolean>;
    deleteHostname(hostname: string): Promise<{ status: string } | null>;
    grantEntitlement(tenantId: string, key: string, input: Record<string, unknown>, actor: string): Promise<{ changed: boolean }>;
    revokeEntitlement(tenantId: string, key: string): Promise<{ plan: string | null } | null>;
  };
  const newHost = (controlPlane = env.CONTROL_PLANE) => new CloudflareScopeHost({ scope: env.SCOPE, controlPlane,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
  const ACTIONS = ['bindHostname', 'setHostnameStatus', 'setHostnameIssuance', 'unbindHostname', 'grantEntitlement', 'revokeEntitlement'] as const;
  const world = async (host: CloudflareScopeHost) => {
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `skew-${ulid().toLowerCase()}`, name: 'Skew' });
    const slug = `skew-${ulid().toLowerCase()}`;
    await host.admin.registerVertical(staff, { slug, name: 'Skew', source: 'builtin' });
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: slug });
    return { t, s, slug };
  };
  const nameOf = () => `skew-${ulid().toLowerCase()}.example.com`;

  it('an old coordinator\'s direct calls still write, without a row of their own', async () => {
    const host = newHost();
    try {
      const cp = cpStub();
      const { t, s, slug } = await world(host);
      const hostname = nameOf();
      const since = new Date().toISOString();
      await cp.demoteCanonical(s, 'app');
      await cp.upsertHostname({ hostname, tenantId: t, scopeId: s, verticalSlug: slug, surface: 'app', region: null, canonical: true, createdAt: since });
      await expect(cp.setHostnameStatus(hostname, 'verifying', null)).resolves.toBe(true);
      await expect(cp.setHostnameIssuance(hostname, { status: 'active', note: null, validationRecords: null })).resolves.toBe(true);
      expect((await host.admin.listHostnames(staff, { scopeId: s })).map((h) => [h.hostname, h.status])).toEqual([[hostname, 'active']]);
      await expect(cp.deleteHostname(hostname)).resolves.toMatchObject({ status: 'active' });
      await expect(cp.grantEntitlement(t, 'skew-entitlement', { plan: 'pro' }, staff)).resolves.toMatchObject({ changed: true });
      expect((await host.admin.listEntitlements(staff, t)).map((e) => e.plan)).toEqual(['pro']);
      await expect(cp.revokeEntitlement(t, 'skew-entitlement')).resolves.toMatchObject({ plan: 'pro' });
      expect(await host.admin.listHostnames(staff, { scopeId: s })).toEqual([]);
      expect(await host.admin.listEntitlements(staff, t)).toEqual([]);
      // The old coordinator records its own rows; the DO wrote none for it.
      expect(await host.admin.auditLog(staff, { since, action: [...ACTIONS] })).toEqual([]);
    } finally {
      await host.close();
    }
  });

  const NEW_REPLIED = ['bindHostnameInDirectory', 'setHostnameStatus', 'setHostnameIssuance', 'deleteHostname', 'grantEntitlement', 'revokeEntitlement'];
  const oldDo = () => interceptedControlPlane(async (args, method) => {
    if (method !== 'reply' || !NEW_REPLIED.includes(args[0] as string)) return;
    return { answer: { failure: toWireFailure(new Error(`not a replied directory method: ${String(args[0])}`)) } };
  });

  it('a new coordinator against an old DO fails closed, naming the method, and writes nothing', async () => {
    const reader = newHost();
    const host = newHost(oldDo());
    try {
      const { t, s } = await world(reader);
      const held = nameOf();
      // Arranged by an actor of its own, so the refused calls' rows are exactly staff's.
      const setup = platformActorId.parse(ulid());
      await reader.admin.bindHostname(setup, { hostname: held, tenantId: t, scopeId: s, surface: 'app', region: null, canonical: true });
      await reader.admin.grantEntitlement(setup, t, 'held', { plan: 'pro' });
      const since = new Date().toISOString();
      const refused: [Promise<unknown>, string][] = [
        [host.admin.bindHostname(staff, { hostname: nameOf(), tenantId: t, scopeId: s, surface: 'app', region: null, canonical: true }), 'bindHostnameInDirectory'],
        [host.admin.setHostnameStatus(staff, held, 'active'), 'setHostnameStatus'],
        [host.admin.setHostnameIssuance(staff, held, { status: 'verifying', validationRecords: [] }), 'setHostnameIssuance'],
        [host.admin.unbindHostname(staff, held), 'deleteHostname'],
        [host.admin.grantEntitlement(staff, t, 'other', { plan: 'pro' }), 'grantEntitlement'],
        [host.admin.revokeEntitlement(staff, t, 'held'), 'revokeEntitlement'],
      ];
      for (const [call, method] of refused) await expect(call).rejects.toThrow(`not a replied directory method: ${method}`);
      expect((await reader.admin.listHostnames(staff, { scopeId: s })).map((h) => [h.hostname, h.status, h.canonical]))
        .toEqual([[held, 'pending', true]]);
      expect((await reader.admin.listEntitlements(staff, t)).map((e) => e.entitlementKey)).toEqual(['held']);
      expect((await reader.admin.auditLog(staff, { since, action: [...ACTIONS] })).filter((r) => r.actor === staff)).toEqual([]);
    } finally {
      await host.close();
      await reader.close();
    }
  });
});

/**
 * #2526: `grantToConnection` at a scope node writes its directory record and admin row as one unit,
 * then delivers the tuple to the deployment serving the scope. A refused delivery fails the call
 * and leaves the record and its row; the reconcile's re-seat from the record (that deployment's
 * `seatScopeLocal`, with the grants the platform gathers from `listConnectionGrants`) delivers it.
 * The shape is the hosted one: a delegating platform host, and a CP-less host as the deployment.
 */
describe('#2526: a refused connection-grant delivery is repaired from the record', () => {
  it('leaves the record and its row, and a re-seat from the record restores the tuple', async () => {
    const staff = platformActorId.parse(ulid());
    const USE = permissionKey.parse('delivery:use');
    const vertical = `delivery-${ulid().toLowerCase()}`;
    const deployment = new CloudflareScopeHost({ scope: env.SCOPE });
    const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      connectorDelegation: {
        invoke: async () => { throw new Error('not used'); },
        grant: async (a: Parameters<ConnectorDelegation['grant']>[0]) =>
          deployment.connectorGrantLocal(a.connectionId, a.scopeId, a.permission, a.expiresAt),
      } as unknown as ConnectorDelegation });
    try {
      const t = tenantId.parse(ulid());
      await host.admin.createTenant(staff, { id: t, slug: `delivery-${ulid().toLowerCase()}`, name: 'Delivery' });
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical });
      await host.admin.activateScope(staff, t, s);
      await deployment.provisionScopeLocal({ tenantId: t, scopeId: s, owner: principalId.parse(ulid()),
        roles: [{ key: 'member', permissions: [USE], source: 'vertical' }], ownerRoleKey: 'member' });
      const conn = connectionId.parse(ulid());
      await host.admin.createConnection(staff, { id: conn, tenantId: t, vertical, provider: `delivery-${conn.toLowerCase()}`,
        label: 'Delivery', secret: { accessToken: 'tok' } });
      const scopeDo = env.SCOPE.get(env.SCOPE.idFromName(s));
      const scopeSql = (sql: string) => runInDurableObject(scopeDo, (_, state) => { state.storage.sql.exec(sql); });
      const recorded = async () => (await host.admin.listConnectionGrants(staff, t)).filter((g) => g.connectionId === conn);
      const rows = async () => (await host.admin.auditLog(staff, { tenantId: t, action: ['grantToConnection'] })).length;
      const delivered = async () => runInDurableObject(scopeDo, (_, state) => state.storage.sql.exec(
        'SELECT 1 FROM _substrat_tuples WHERE subject = ? AND relation = ? AND revoked_at IS NULL', `connection:${conn}`, `granted:${USE}`,
      ).toArray().length);

      await scopeSql(`CREATE TRIGGER test_refuse_delivery BEFORE INSERT ON _substrat_tuples
        BEGIN SELECT RAISE(ABORT, 'refused by test_refuse_delivery (test fault)'); END`);
      await expect(host.admin.grantToConnection(staff, { connectionId: conn, permission: USE, node: { tenantId: t, scopeId: s }, grantedBy: staff }))
        .rejects.toThrow(/test fault/);
      expect([(await recorded()).length, await rows(), await delivered()]).toEqual([1, 1, 0]);

      await scopeSql('DROP TRIGGER test_refuse_delivery');
      const gathered = (await recorded()).filter((g) => g.scopeId === s)
        .map((g) => ({ connectionId: g.connectionId, permission: g.permission }));
      await deployment.seatScopeLocal({ tenantId: t, scopeId: s, connectionGrants: gathered });
      expect([(await recorded()).length, await rows(), await delivered()]).toEqual([1, 1, 1]);
    } finally {
      await host.close();
      await deployment.close();
    }
  });
});

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

// #2005: a fork or a preview causes no outbound effects — on the coordinator, which is where
// a co-located host runs its executors and reads the directory that says what a scope is.
inertScopeContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    fetch: connectorTestFetch,
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    checker: UNSAFE_allowAllChecker,
  });
  return { host, cleanup: async () => host.close() };
});

// One directory row that does not read as a scope never stops a fleet-wide pass. The row is
// written in the ControlPlaneDO's own SQL, past the provisioning boundary that now refuses it.
unreadableScopeRowContractSuite(
  'adapter-cloudflare',
  async () => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      checker: UNSAFE_allowAllChecker,
    });
    return { host, cleanup: async () => host.close() };
  },
  async (_host, sql) => {
    await runInDurableObject(env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')), (_i, state) => {
      state.storage.sql.exec(sql);
    });
  },
);

// A copy takes the vertical its source stores; a caller's is held to the registry grammar.
storedVerticalCopyContractSuite(
  'adapter-cloudflare',
  async () => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      checker: UNSAFE_allowAllChecker,
    });
    return { host, cleanup: async () => host.close() };
  },
  async (_host, sql) => {
    await runInDurableObject(env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')), (_i, state) => {
      state.storage.sql.exec(sql);
    });
  },
);

// #2300: a store driver's releases, rollouts and holds, in the ControlPlaneDO. The hold-expiry
// transition is the pure host's alone: this object reads the wall clock (#956).
storeDriverReleaseContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    fetch: connectorTestFetch,
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    checker: UNSAFE_allowAllChecker,
  });
  return { host, cleanup: async () => host.close() };
});

it('checks stored release bytes before an approval write through the Cloudflare directory', async () => {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE, checker: UNSAFE_allowAllChecker });
  try {
    const actor = platformActorId.parse(ulid());
    const driver = `review-${ulid()}`;
    const release = { sourceCommit: 'c'.repeat(40), entry: 'driver_graph/store.py',
      modules: [{ name: 'driver_graph/store.py', content: new TextEncoder().encode('class Store:\n    pass\n') }] };
    const sha256 = await storeDriverReleaseDigest(release);
    const bytes = new Map<string, Uint8Array>();
    let headSize: number | undefined;
    let openedSize: number | undefined;
    let opened = 0;
    const storedBytes = {
      get: async (key: string) => bytes.get(key),
      put: async (key: string, value: Uint8Array) => { bytes.set(key, value); },
      head: async (key: string) => {
        const raw = bytes.get(key);
        return raw ? { size: headSize ?? raw.byteLength } : undefined;
      },
      open: async (key: string) => {
        opened++;
        const raw = bytes.get(key);
        return raw ? { size: openedSize ?? raw.byteLength, body: new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(raw); controller.close(); },
        }) } : undefined;
      },
    };
    const wire = (content: string) => new TextEncoder().encode(JSON.stringify({ sourceCommit: release.sourceCommit, entry: release.entry,
      modules: [{ name: release.entry, contentBase64: btoa(content) }] }));
    const input = { admin: host.admin, actor, bytes: storedBytes, driver, sha256, approval: {
      reason: 'Reviewed the release', sourceReferences: [{ repository: 'https://example.test/driver.git', commit: release.sourceCommit }],
      isolationReview: {}, schema: 1, className: 'Store', operations: [],
    } };
    await host.admin.recordStoreDriverRelease(actor, { driver, sha256, sourceCommit: release.sourceCommit });
    await expect(approveStoredDriverRelease(input)).rejects.toMatchObject({ status: 404 });
    bytes.set(storeReleaseKey(driver, sha256), wire('class Store:\n    changed = True\n'));
    await expect(approveStoredDriverRelease(input)).rejects.toMatchObject({ status: 409 });
    expect(await host.admin.storeDriverApprovals(actor, driver)).toEqual([]);
    const good = wire('class Store:\n    pass\n');
    bytes.set(storeReleaseKey(driver, sha256), new Uint8Array(Math.ceil((10 * 1024 * 1024 * 4) / 3) + 1024 * 1024 + 1));
    const before = opened;
    await expect(approveStoredDriverRelease(input)).rejects.toMatchObject({ status: 409 });
    expect(opened).toBe(before);
    bytes.set(storeReleaseKey(driver, sha256), good);
    headSize = good.byteLength + 1;
    openedSize = good.byteLength;
    await expect(approveStoredDriverRelease(input)).rejects.toMatchObject({ status: 409 });
    expect(await host.admin.storeDriverApprovals(actor, driver)).toEqual([]);
    headSize = good.byteLength - 1;
    openedSize = headSize;
    await expect(approveStoredDriverRelease(input)).rejects.toMatchObject({ status: 409 });
    expect(await host.admin.storeDriverApprovals(actor, driver)).toEqual([]);
    headSize = undefined;
    openedSize = undefined;
    expect(await approveStoredDriverRelease(input)).toMatchObject({ driver, sha256, sourceCommit: release.sourceCommit });
  } finally {
    await host.close();
  }
});

// connections.md §3.5.4: a vertical's mailed connect link — the kernel's statements, run inside
// the ControlPlaneDO, which is where the hosted single-use guarantee has to hold.
connectLinkContractSuite(
  'adapter-cloudflare',
  async () => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      checker: UNSAFE_allowAllChecker,
    });
    return { host, cleanup: async () => host.close() };
  },
  async (_host, sql) => {
    await runInDurableObject(env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')), (_i, state) => {
      state.storage.sql.exec(sql);
    });
  },
);

// #1748: findings — the directory half lives in the ControlPlaneDO, so this is the proof that
// the kernel's statements (json_each, RETURNING, the upsert) run on DO SQLite.
scopeStoreContractSuite('adapter-cloudflare', async (scopeStores) => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    checker: UNSAFE_allowAllChecker,
    scopeStores,
  });
  return { host, cleanup: async () => host.close() };
});

findingsContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    checker: UNSAFE_allowAllChecker,
  });
  return { host, cleanup: async () => host.close() };
});

// #1748: the evidence, the finding and the audit row commit together — the DO's own unit is
// what holds it here. The faults are triggers on the directory singleton the host talks to.
findingsAtomicContractSuite(
  'adapter-cloudflare',
  async () => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      checker: UNSAFE_allowAllChecker,
    });
    return { host, cleanup: async () => host.close() };
  },
  async (_host, sql) => {
    await runInDurableObject(env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')), (_i, state) => {
      state.storage.sql.exec(sql);
    });
  },
);

// #2055: an executor's event is stamped on its own admin rows only — never on a call the
// coordinator serves while the handler awaits.
causedByContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    checker: UNSAFE_allowAllChecker,
  });
  return { host, cleanup: async () => host.close() };
});

// …and the scope's half, in a ScopeDO class of its own: a DO closes over its module set, and
// the held consumer must be in it (`CausedByScopeDO`, test/worker.ts).
scopeCausedByContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.CAUSED_BY_SCOPE,
    controlPlane: env.CONTROL_PLANE,
    checker: UNSAFE_allowAllChecker,
  });
  return { host, cleanup: async () => host.close() };
});

// #2447 (review round 1): most deployed scope classes reserve nothing, so the person's doors at a
// scope node must not short-circuit on an empty reservation: a role stored `holder: 'system'` is
// still no person's. `CausedByScopeDO` registers no module reserving a key, which is that shape.
describe('a scope class that reserves nothing: its person’s doors read the stored holder (#2447)', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const caller = principalId.parse(ulid());
  const host = new CloudflareScopeHost({ scope: env.CAUSED_BY_SCOPE, controlPlane: env.CONTROL_PLANE });
  const RUN = permissionKey.parse('nor:run');
  const USE = permissionKey.parse('nor:use');
  const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as Error);
  const SYSTEM_HELD = /role 'runner' is declared holder: 'system', a role for a system principal: no person's bound covers it/;

  beforeAll(async () => {
    await host.admin.createTenant(staff, { id: t, slug: `nor-${t.slice(-10).toLowerCase()}`, name: 'Reserves nothing' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'nor-vertical' });
    await host.admin.activateScope(staff, t, s);
    await host.admin.defineRole(staff, t, { key: 'runner', permissions: [RUN], source: 'vertical', holder: 'system' });
    await host.admin.defineRole(staff, t, { key: 'member', permissions: [USE], source: 'vertical' });
  });
  afterAll(() => host.close());

  it('assignScopeRoleBounded refuses the system-held role and seats nothing; its twin is answered by the bound', async () => {
    const who = principalId.parse(ulid());
    const refused = await failure(host.assignScopeRoleBounded(t, s, caller, who, 'runner'));
    expect(errorCodeOf(refused)).toBe('forbidden');
    expect(refused?.message).toMatch(SYSTEM_HELD);
    expect(await host.listScopeRoleHolders(t, s, who)).toEqual([]);
    // The twin: a person's role reaches the bound, which answers coverage instead of a refusal.
    expect(await host.assignScopeRoleBounded(t, s, caller, who, 'member')).toMatchObject({ covered: false });
  });

  it('changeScopeRoleBounded refuses moving someone into it, leaving the role they held', async () => {
    const who = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: who, roleKey: 'member', node: { tenantId: t, scopeId: s } });
    const refused = await failure(host.changeScopeRoleBounded(t, s, caller, who, 'member', 'runner'));
    expect(errorCodeOf(refused)).toBe('forbidden');
    expect(refused?.message).toMatch(SYSTEM_HELD);
    expect(await host.listScopeRoleHolders(t, s, who)).toEqual([{ principal: who, roleKey: 'member' }]);
  });

  it('canAssign refuses it; its twin answers coverage', async () => {
    const refused = await failure(host.canAssign(t, s, caller, 'runner'));
    expect(errorCodeOf(refused)).toBe('forbidden');
    expect(refused?.message).toMatch(SYSTEM_HELD);
    expect(await host.canAssign(t, s, caller, 'member')).toMatchObject({ covered: false });
  });
});

// #2447 (review round 3): a scope's projected copy of the tenant-level tuples is not where seats are
// counted. The fan-out skips an archived scope, so its copy goes stale; the tenant-level seats are
// the ControlPlaneDO's, read in its own unit.
describe('an archived scope’s stale projected tenant tuples are not seats (#2447)', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE, scopeLocalPermissions: true });
  const USE = permissionKey.parse('rsv:use');
  const RUN = permissionKey.parse('rsv:run');
  afterAll(() => host.close());

  it('a tenant-level seat taken back while the scope was archived blocks nothing; a live one still does', async () => {
    await host.admin.createTenant(staff, { id: t, slug: `stale-${t.slice(-10).toLowerCase()}`, name: 'Stale' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'stale-vertical' });
    await host.admin.activateScope(staff, t, s);
    for (const key of ['stale', 'live']) await host.admin.defineRole(staff, t, { key, permissions: [USE], source: 'vertical' });
    const who = principalId.parse(ulid());
    for (const key of ['stale', 'live']) await host.admin.assignRole(staff, { principalId: who, roleKey: key, node: { tenantId: t, scopeId: null } });
    await host.admin.archiveScope(staff, t, s);
    await host.admin.unassignRole(staff, { principalId: who, roleKey: 'stale', node: { tenantId: t, scopeId: null } });
    // The archived scope's projection still names the seat; the directory does not.
    await host.admin.defineRole(staff, t, { key: 'stale', permissions: [RUN], source: 'vertical', holder: 'system' });
    expect((await host.admin.listRoles(staff, { tenantId: t })).find((r) => r.key === 'stale')?.holder).toBe('system');
    // The twin: a tenant-level seat that is still live is counted, in the ControlPlaneDO's unit.
    const refused = await host.admin
      .defineRole(staff, t, { key: 'live', permissions: [RUN], source: 'vertical', holder: 'system' })
      .then(() => undefined, (e: unknown) => e as Error);
    expect(errorCodeOf(refused)).toBe('forbidden');
    expect(refused?.message).toMatch(/role 'live' is held by a principal/);
  });
});

// #1184: the membership executor, on the DEFAULT tuple checker — the bound is a set
// comparison an allow-all checker would answer "covered" for everything. Its executors run
// here on the coordinator; the fixture module is in `contractTestModules`, so the ScopeDO has it.
membershipExecutorContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

// #2430: the role doors and the declared module list, on the default tuple checker. The ScopeDO's
// own module set (`contractTestModules`) carries the reserving module, as a deployed one would.
reservedRoleContractSuite('adapter-cloudflare', async (options) => {
  // The box seals the secret of the connection the suite grants to.
  const secretBox = webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE, secretBox, ...options });
  return { host, cleanup: async () => host.close() };
});

// #2446: the role state a promote judges a release against, through the ScopeDO's `roleStateHere`.
roleStateContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  return {
    host,
    roleState: (t, s) => host.roleStateLocal(t, s),
    // A pushed vertical's scope stores the roles its reconcile projects, which is what a promote reads.
    projectRoles: (t, s, roles) => host.projectRolesLocal(t, s, roles),
    cleanup: async () => host.close(),
  };
});

// #2555: a restore judges the directory's roles against the dump's seats, on a host whose scopes read
// their roles locally (the dump stores the projected role rows) and on one whose scopes read them over
// RPC (it stores none).
for (const scopeLocalPermissions of [true, false]) {
  restoreRoleContractSuite(`adapter-cloudflare (scopeLocalPermissions: ${scopeLocalPermissions})`, async () => {
    const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE, scopeLocalPermissions });
    return {
      host,
      roleState: (t, s) => host.roleStateLocal(t, s),
      dumpCarriesRoles: scopeLocalPermissions,
      readsRolesRemotely: !scopeLocalPermissions,
      cleanup: async () => host.close(),
    };
  });
}


// #2430: the scope class's own reservations decide at a scope node, whatever the coordinator in
// front of it registers — here one that registers no module reserving anything.
describe('a coordinator that reserves nothing, in front of a ScopeDO class that does (#2430)', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  // The box seals the secret of the connection granted to below.
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
  const MIXED = [permissionKey.parse('rsv:use'), permissionKey.parse('rsv:run')];

  beforeAll(async () => {
    await host.admin.createTenant(staff, { id: t, slug: `rsv-front-${t.slice(-10).toLowerCase()}`, name: 'Front' });
    // #2447: a definition joins the scope class's reservations once the tenant has a scope, so these
    // roles, which hold the class's reserved key, are defined first: a tenant with no scope yet is
    // judged by this coordinator's modules alone, which reserve nothing (a stated residual).
    await host.admin.defineRole(staff, t, { key: 'mixed', permissions: MIXED, source: 'vertical' });
    await host.admin.defineRole(staff, t, { key: 'cp-mixed', permissions: MIXED, source: 'vertical' });
    await host.admin.defineRole(staff, t, { key: 'cp-member', permissions: [MIXED[0]!], source: 'vertical' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'rsv-front' });
    await host.admin.activateScope(staff, t, s);
  });

  it('defineRole judges the scope class’s reservations, not only the coordinator’s (#2447 round 1); an unreserved key is admitted', async () => {
    const refused = await host.admin
      .defineRole(staff, t, { key: 'mixed-2', permissions: MIXED, source: 'vertical' })
      .then(() => undefined, (e: unknown) => e as Error);
    expect(errorCodeOf(refused)).toBe('forbidden');
    expect(refused?.message).toMatch(/role 'mixed-2' is a person's role and would hold rsv:run/);
    expect((await host.admin.listRoles(staff, { tenantId: t })).some((r) => r.key === 'mixed-2')).toBe(false);
    await host.admin.defineRole(staff, t, { key: 'mixed-2', permissions: [MIXED[0]!, permissionKey.parse('rsv:other')], source: 'vertical' });
  });

  describe('a tenant whose only scope was archived straight from provisioning (#2447 round 4)', () => {
    const tenantWithEarlyScope = async () => {
      const tn = tenantId.parse(ulid());
      const early = scopeId.parse(ulid());
      await host.admin.createTenant(staff, { id: tn, slug: `rsv-early-${tn.slice(-10).toLowerCase()}`, name: 'Early' });
      await host.provisionScope(staff, { tenantId: tn, scopeId: early, vertical: 'rsv-front' }); // never activated
      await host.admin.archiveScope(staff, tn, early);
      return { tn, early };
    };
    const refusalOf = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as Error);

    it('still reads the scope class’s reservations there: a mixed person’s role is refused; an unreserved key is admitted', async () => {
      const { tn } = await tenantWithEarlyScope();
      const refused = await refusalOf(host.admin.defineRole(staff, tn, { key: 'mixed-3', permissions: MIXED, source: 'vertical' }));
      expect(errorCodeOf(refused)).toBe('forbidden');
      expect(refused?.message).toMatch(/role 'mixed-3' is a person's role and would hold rsv:run/);
      await host.admin.defineRole(staff, tn, { key: 'mixed-3', permissions: [MIXED[0]!], source: 'vertical' });
    });

    it('fails closed for a system-held definition its seats could decide, even beside an active scope; unarchived, the seat itself refuses it (round 5)', async () => {
      const { tn, early } = await tenantWithEarlyScope();
      const live = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: tn, scopeId: live, vertical: 'rsv-front' });
      await host.admin.activateScope(staff, tn, live);
      // A person seated in `esc` there (unarchived to seat it), then the scope archived again and its row
      // made to read as archived straight from provisioning with no migration recorded.
      await host.admin.unarchiveScope(staff, tn, early);
      await host.admin.defineRole(staff, tn, { key: 'esc', permissions: [MIXED[0]!], source: 'vertical' });
      await host.admin.assignRole(staff, { principalId: principalId.parse(ulid()), roleKey: 'esc', node: { tenantId: tn, scopeId: early } });
      await host.admin.archiveScope(staff, tn, early);
      await runInDurableObject(env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')), (_instance, state) => {
        state.storage.sql.exec('UPDATE scopes SET archived_from_status = ?, schema_version = ? WHERE scope_id = ?', 'provisioning', '0', early);
      });
      const system = { key: 'esc', permissions: [MIXED[1]!], source: 'vertical' as const, holder: 'system' as const };
      const refused = await refusalOf(host.admin.defineRole(staff, tn, system));
      expect(errorCodeOf(refused)).toBe('forbidden');
      expect(refused?.message).toContain(`role 'esc' cannot be judged: scope ${early} was archived straight from provisioning and records no migration`);
      // The twin: unarchived, the scope is read, and its seat refuses the same definition for what it is.
      await host.admin.unarchiveScope(staff, tn, early);
      const seated = await refusalOf(host.admin.defineRole(staff, tn, system));
      expect(errorCodeOf(seated)).toBe('forbidden');
      expect(seated?.message).toMatch(/role 'esc' is held by a principal/);
    });

    it('fails closed when that scope records no migration (its DO may never have run), naming it; unarchived, the same definition is judged', async () => {
      const { tn, early } = await tenantWithEarlyScope();
      await runInDurableObject(env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')), (_instance, state) => {
        state.storage.sql.exec('UPDATE scopes SET schema_version = ? WHERE scope_id = ?', '0', early);
      });
      for (const role of [
        { key: 'sys', permissions: [MIXED[1]!], source: 'vertical' as const, holder: 'system' as const },
        { key: 'plain', permissions: [MIXED[0]!], source: 'vertical' as const },
      ]) {
        const refused = await refusalOf(host.admin.defineRole(staff, tn, role));
        expect(errorCodeOf(refused)).toBe('forbidden');
        expect(refused?.message).toContain(`role '${role.key}' cannot be judged: scope ${early} was archived straight from provisioning and records no migration`);
      }
      await host.admin.unarchiveScope(staff, tn, early);
      await host.admin.defineRole(staff, tn, { key: 'sys', permissions: [MIXED[1]!], source: 'vertical', holder: 'system' });
      await host.admin.defineRole(staff, tn, { key: 'plain', permissions: [MIXED[0]!], source: 'vertical' });
    });
  });

  it('…so a seated role is not widened: the refused definition writes nothing, and nothing is fanned out (#2447 round 1)', async () => {
    const who = principalId.parse(ulid());
    await host.admin.defineRole(staff, t, { key: 'grows', permissions: [MIXED[0]!], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: who, roleKey: 'grows', node: { tenantId: t, scopeId: s } });
    const widened = await host.admin
      .defineRole(staff, t, { key: 'grows', permissions: MIXED, source: 'vertical' })
      .then(() => undefined, (e: unknown) => e);
    expect(errorCodeOf(widened)).toBe('forbidden');
    expect((await host.admin.listRoles(staff, { tenantId: t })).find((r) => r.key === 'grows')?.permissions).toEqual([MIXED[0]]);
  });
  afterAll(() => host.close());

  it('refuses a mixed role at a scope node, and a raw grant of the reserved key there', async () => {
    const who = principalId.parse(ulid());
    const refusal = await host.admin
      .assignRole(staff, { principalId: who, roleKey: 'mixed', node: { tenantId: t, scopeId: s } })
      .then(() => undefined, (e: unknown) => e);
    expect(errorCodeOf(refusal)).toBe('forbidden');
    const grant = await host.admin
      .grant(staff, { principalId: who, permission: MIXED[1]!, node: { tenantId: t, scopeId: s }, grantedBy: who })
      .then(() => undefined, (e: unknown) => e);
    expect(errorCodeOf(grant)).toBe('forbidden');
  });

  it('grantEntityLocal refuses the reserved key at a scope node and writes nothing; its twin grants a person’s key', async () => {
    const who = principalId.parse(ulid());
    const entity = { entityType: 'rsvdoc', entityId: ulid() };
    const refused = await host.grantEntityLocal(s, who, MIXED[1]!, entity).then(() => undefined, (e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('forbidden');
    expect((refused as Error).message).toMatch(/rsv:run cannot be granted to a principal, an org or a connection: reserved to a system principal/);
    expect(await grantedTo(s, `principal:${who}`)).toEqual([]);
    await host.grantEntityLocal(s, who, MIXED[0]!, entity);
    expect(await grantedTo(s, `principal:${who}`)).toEqual([`granted:${MIXED[0]}`]);
  });

  // A connection acts for the external provider holding its token, so it is refused a reserved key
  // like a person is — here by the serving scope class's reservations, the coordinator having none.
  describe('a connection grant', () => {
    const connection = async () => {
      const conn = connectionId.parse(ulid());
      await host.admin.createConnection(staff, {
        id: conn,
        tenantId: t,
        vertical: 'rsv-front',
        provider: `rsv-${conn.toLowerCase()}`,
        label: 'reserved-key connection',
        secret: { accessToken: 'tok' },
      });
      return conn;
    };

    it('connectorGrantLocal refuses the reserved key at the scope it serves and writes nothing; its twin grants', async () => {
      const conn = await connection();
      const refused = await host.connectorGrantLocal(conn, s, MIXED[1]!).then(() => undefined, (e: unknown) => e);
      expect(errorCodeOf(refused)).toBe('forbidden');
      expect(await grantedTo(s, `connection:${conn}`)).toEqual([]);
      await host.connectorGrantLocal(conn, s, MIXED[0]!);
      expect(await grantedTo(s, `connection:${conn}`)).toEqual([`granted:${MIXED[0]}`]);
    });

    // A grant the directory recorded (before these checks, or before the serving deployment judged it)
    // reaches a scope again at every provision and reconcile: skipped there and reported, never a
    // failed provision, while every other delivered grant is seated.
    it('a provision and a reconcile re-seat skip a delivered grant naming the reserved key and report it, seating the rest', async () => {
      const local = new CloudflareScopeHost({ scope: env.SCOPE }); // CP-less, as a deployed vertical's host is
      const owned = scopeId.parse(ulid());
      const tenant = tenantId.parse(ulid());
      const conn = connectionId.parse(ulid());
      const other = connectionId.parse(ulid());
      const delivered = [
        { connectionId: conn, permission: MIXED[1]! },
        { connectionId: conn, permission: MIXED[0]! },
      ];
      try {
        const provisioned = await local.provisionScopeLocal({
          tenantId: tenant,
          scopeId: owned,
          owner: principalId.parse(ulid()),
          roles: [{ key: 'member', permissions: [MIXED[0]!], source: 'vertical' }],
          ownerRoleKey: 'member',
          connectionGrants: delivered,
        });
        expect(provisioned.skippedConnectionGrants).toEqual([{ connectionId: conn, permission: MIXED[1] }]);
        expect(await grantedTo(owned, `connection:${conn}`)).toEqual([`granted:${MIXED[0]}`]);
        const seated = await local.seatScopeLocal({
          tenantId: tenant,
          scopeId: owned,
          connectionGrants: [...delivered, { connectionId: other, permission: MIXED[0]! }],
        });
        expect(seated.skippedConnectionGrants).toEqual([{ connectionId: conn, permission: MIXED[1] }]);
        expect(await grantedTo(owned, `connection:${conn}`)).toEqual([`granted:${MIXED[0]}`]);
        expect(await grantedTo(owned, `connection:${other}`)).toEqual([`granted:${MIXED[0]}`]);
        // Its twin: nothing reserved delivered, nothing reported.
        expect(await local.seatScopeLocal({ tenantId: tenant, scopeId: owned, connectionGrants: [{ connectionId: other, permission: MIXED[0]! }] })).not.toHaveProperty(
          'skippedConnectionGrants',
        );
      } finally {
        await local.close();
      }
    });

    it('grantToConnection at a scope served here refuses it before the directory records anything; its twin records', async () => {
      const conn = await connection();
      const grant = (permission: (typeof MIXED)[number]) =>
        host.admin.grantToConnection(staff, { connectionId: conn, permission, node: { tenantId: t, scopeId: s }, grantedBy: staff });
      const recorded = async () => (await host.admin.listConnectionGrants(staff, t)).filter((g) => g.connectionId === conn).map((g) => g.permission);
      const refused = await grant(MIXED[1]!).then(() => undefined, (e: unknown) => e);
      expect(errorCodeOf(refused)).toBe('forbidden');
      expect(await recorded()).toEqual([]);
      expect(await grantedTo(s, `connection:${conn}`)).toEqual([]);
      await grant(MIXED[0]!);
      expect(await recorded()).toEqual([MIXED[0]]);
    });
  });

  it('a reconcile of declared shapes refuses one holding the reserved key at a scope node; its twin reconciles', async () => {
    const node = { tenantId: t, scopeId: s };
    const refused = await host.admin
      .reconcileEntityGrantShapes(staff, node, [{ entityType: 'rsvdoc', permissions: MIXED, bootstrap: true }])
      .then(() => undefined, (e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('forbidden');
    expect((refused as Error).message).toMatch(/the entity grant shape on rsvdoc: rsv:run cannot be granted/);
    expect(await host.admin.reconcileEntityGrantShapes(staff, node, [{ entityType: 'rsvdoc', permissions: [MIXED[0]!], bootstrap: true }])).toMatchObject({ retired: 0 });
  });

  it('provisionScopeLocal refuses declared shapes holding the reserved key before it writes anything; its twin provisions', async () => {
    const local = new CloudflareScopeHost({ scope: env.SCOPE });
    const provision = (scope: ScopeId, permissions: typeof MIXED) =>
      local.provisionScopeLocal({
        tenantId: tenantId.parse(ulid()),
        scopeId: scope,
        owner: principalId.parse(ulid()),
        roles: [{ key: 'member', permissions: [MIXED[0]!], source: 'vertical' }],
        ownerRoleKey: 'member',
        entityGrants: [{ entityType: 'rsvdoc', permissions, bootstrap: true }],
      });
    const receiptOf = (scope: ScopeId) =>
      runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_instance, state) =>
        state.storage.sql.exec(`SELECT value FROM _substrat_meta WHERE key = 'provisioned_for'`).toArray(),
      );
    try {
      const refusedScope = scopeId.parse(ulid());
      const refused = await provision(refusedScope, MIXED).then(() => undefined, (e: unknown) => e);
      expect(errorCodeOf(refused)).toBe('forbidden');
      expect(await receiptOf(refusedScope)).toEqual([]);
      const twin = scopeId.parse(ulid());
      await provision(twin, [MIXED[0]!]);
      expect(await receiptOf(twin)).toHaveLength(1);
    } finally {
      await local.close();
    }
  });

  it('assignScopeRole on a provisioned scope judges the role its receipt’s tenant defines; its twin assigns', async () => {
    // A CP-less host, as a deployed vertical's is: `provisionScopeLocal` writes the receipt and the roles.
    const local = new CloudflareScopeHost({ scope: env.SCOPE });
    const owned = scopeId.parse(ulid());
    const tenant = tenantId.parse(ulid());
    try {
      await local.provisionScopeLocal({
        tenantId: tenant,
        scopeId: owned,
        owner: principalId.parse(ulid()),
        roles: [{ key: 'member', permissions: [MIXED[0]!], source: 'vertical' }],
        ownerRoleKey: 'member',
      });
      // #2447: a provision refuses defining `mixed` here, so it reaches the scope as a row projected
      // before the key was reserved would.
      await projector(owned).projectRole(tenant, { key: 'mixed', permissions: MIXED, source: 'vertical' });
      const refused = await local.assignScopeRole(owned, principalId.parse(ulid()), 'mixed').then(() => undefined, (e: unknown) => e);
      expect(errorCodeOf(refused)).toBe('forbidden');
      await local.assignScopeRole(owned, principalId.parse(ulid()), 'member');
    } finally {
      await local.close();
    }
  });

  // #2447: the roles a CP-less provision or restore defines, and the owner's seat in them, judged
  // against the scope class's reservations though the coordinator has none.
  describe('roles a host defines and seats itself (#2447)', () => {
    const member = { key: 'member', permissions: [MIXED[0]!], source: 'vertical' as const };
    const runner = { key: 'runner', permissions: [MIXED[1]!], source: 'vertical' as const, holder: 'system' as const };
    const receiptOf = (scope: ScopeId) =>
      runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_instance, state) =>
        state.storage.sql.exec(`SELECT value FROM _substrat_meta WHERE key = 'provisioned_for'`).toArray(),
      );
    const rolesOf = (scope: ScopeId) =>
      runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_instance, state) => {
        const has = state.storage.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_substrat_roles'`).toArray().length > 0;
        return has ? (state.storage.sql.exec(`SELECT role_key FROM _substrat_roles ORDER BY role_key`).toArray() as { role_key: string }[]).map((r) => r.role_key) : [];
      });
    const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as Error);
    let local: CloudflareScopeHost;
    beforeAll(() => {
      local = new CloudflareScopeHost({ scope: env.SCOPE }); // CP-less, as a deployed vertical's host is
    });
    afterAll(() => local.close());
    const provision = (scope: ScopeId, roles: RoleDefinition[], ownerRoleKey: string) =>
      local.provisionScopeLocal({ tenantId: tenantId.parse(ulid()), scopeId: scope, owner: principalId.parse(ulid()), roles, ownerRoleKey });

    it('provisionScopeLocal refuses a role set with a person’s role carrying the reserved key, writing nothing; its twin provisions', async () => {
      const refusedScope = scopeId.parse(ulid());
      const refused = await failure(provision(refusedScope, [member, { key: 'mixed', permissions: MIXED, source: 'vertical' }], 'member'));
      expect(errorCodeOf(refused)).toBe('forbidden');
      expect(refused?.message).toMatch(/role 'mixed' is a person's role and would hold rsv:run/);
      expect(await receiptOf(refusedScope)).toEqual([]);
      expect(await rolesOf(refusedScope)).toEqual([]);
      const twin = scopeId.parse(ulid());
      await provision(twin, [member, runner], 'member');
      expect(await receiptOf(twin)).toHaveLength(1);
      expect(await rolesOf(twin)).toEqual(['member', 'runner']);
    });

    it('provisionScopeLocal refuses seating the owner, a person, in a system-held role, writing nothing; its twin seats', async () => {
      const refusedScope = scopeId.parse(ulid());
      const refused = await failure(provision(refusedScope, [member, runner], 'runner'));
      expect(errorCodeOf(refused)).toBe('forbidden');
      expect(refused?.message).toMatch(/^the owner's seat: role 'runner' is declared holder: 'system'/);
      expect(await receiptOf(refusedScope)).toEqual([]);
      const twin = scopeId.parse(ulid());
      await provision(twin, [member, runner], 'member');
      expect(await receiptOf(twin)).toHaveLength(1);
    });

    it('projectRolesLocal (a restore’s repair) refuses the same role set and projects nothing; its twin projects', async () => {
      const scope = scopeId.parse(ulid());
      const tenant = tenantId.parse(ulid());
      const refused = await failure(local.projectRolesLocal(tenant, scope, [member, { key: 'mixed', permissions: MIXED, source: 'vertical' }]));
      expect(errorCodeOf(refused)).toBe('forbidden');
      expect(await rolesOf(scope)).toEqual([]);
      await local.projectRolesLocal(tenant, scope, [member, runner]);
      expect(await rolesOf(scope)).toEqual(['member', 'runner']);
    });

    it('a reconcile, and a restore’s repair, refuse making a seated stored person’s role holder: system (round 1); an unseated one changes', async () => {
      const scope = scopeId.parse(ulid());
      const tenant = tenantId.parse(ulid());
      const owner = principalId.parse(ulid());
      const staffer = { key: 'staffer', permissions: [MIXED[0]!], source: 'vertical' as const };
      const idle = { key: 'idle', permissions: [MIXED[0]!], source: 'vertical' as const };
      const flipped = (key: string) => ({ key, permissions: [MIXED[1]!], source: 'vertical' as const, holder: 'system' as const });
      const reconcile = (roles: RoleDefinition[]) => local.provisionScopeLocal({ tenantId: tenant, scopeId: scope, owner, roles, ownerRoleKey: 'member' });
      await reconcile([member, staffer, idle]);
      const who = principalId.parse(ulid());
      await local.assignScopeRole(scope, who, 'staffer');
      const refused = await failure(reconcile([member, flipped('staffer'), idle]));
      expect(errorCodeOf(refused)).toBe('forbidden');
      expect(refused?.message).toMatch(/role 'staffer' is held by a principal/);
      const repair = await failure(local.projectRolesLocal(tenant, scope, [member, flipped('staffer'), idle]));
      expect(errorCodeOf(repair)).toBe('forbidden');
      const holderOf = (key: string) =>
        runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_instance, state) =>
          (state.storage.sql.exec('SELECT holder FROM _substrat_roles WHERE tenant_id = ? AND role_key = ?', tenant, key).toArray()[0] as { holder: string } | undefined)?.holder);
      expect(await holderOf('staffer')).toBe('person');
      // The twin: the role nobody holds may change holder.
      await reconcile([member, staffer, flipped('idle')]);
      expect(await holderOf('idle')).toBe('system');
    });

    it('a release that drops a seated role and a later one that defines it holder: system are refused, like the flip straight after (round 2)', async () => {
      const scope = scopeId.parse(ulid());
      const tenant = tenantId.parse(ulid());
      const owner = principalId.parse(ulid());
      const staffer = { key: 'staffer', permissions: [MIXED[0]!], source: 'vertical' as const };
      const system = { key: 'staffer', permissions: [MIXED[1]!], source: 'vertical' as const, holder: 'system' as const };
      const release = (roles: RoleDefinition[]) => local.provisionScopeLocal({ tenantId: tenant, scopeId: scope, owner, roles, ownerRoleKey: 'member' });
      const rowOf = () =>
        runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_instance, state) =>
          (state.storage.sql.exec('SELECT holder, permissions, revoked_at FROM _substrat_roles WHERE tenant_id = ? AND role_key = ?', tenant, 'staffer').toArray() as {
            holder: string; permissions: string; revoked_at: string | null;
          }[]).map((r) => ({ holder: r.holder, permissions: r.permissions, tombstoned: r.revoked_at !== null })));
      // Release 1: a person's role, and someone seated in it.
      await release([member, staffer]);
      const who = principalId.parse(ulid());
      await local.assignScopeRole(scope, who, 'staffer');
      // The twin: release 3 straight after release 1 is refused.
      expect(errorCodeOf(await failure(release([member, system])))).toBe('forbidden');
      // Release 2 drops the role: its row is tombstoned as the person's role it was (#2531), the seat stays.
      await release([member]);
      expect(await rowOf()).toEqual([{ holder: 'person', permissions: JSON.stringify([MIXED[0]]), tombstoned: true }]);
      // Release 3 defines it holder: system: refused as well (a person's tombstone is no evidence), nothing written.
      const refused = await failure(release([member, system]));
      expect(errorCodeOf(refused)).toBe('forbidden');
      expect(refused?.message).toMatch(/role 'staffer' is held by a principal \(with no definition stored\)/);
      // Named by scope as well as role, so staff can find every scope a release is refused at (SF4).
      expect(refused?.message).toContain(`tenant ${tenant}, scope ${scope}: the vertical's roles cannot be defined here`);
      expect(await rowOf()).toEqual([{ holder: 'person', permissions: JSON.stringify([MIXED[0]]), tombstoned: true }]);
    });

    it('a reconcile refuses making a seated legacy holder-less role system-held, with the same keys; an unseated one upgrades (round 3)', async () => {
      const scope = scopeId.parse(ulid());
      const tenant = tenantId.parse(ulid());
      const owner = principalId.parse(ulid());
      const release = (roles: RoleDefinition[]) => local.provisionScopeLocal({ tenantId: tenant, scopeId: scope, owner, roles, ownerRoleKey: 'member' });
      await release([member]);
      // Rows from before #2444: projected with no holder.
      for (const key of ['ops', 'idle']) await projector(scope).projectRole(tenant, { key, permissions: [MIXED[1]!], source: 'vertical' });
      const who = principalId.parse(ulid());
      await local.assignScopeRole(scope, who, 'ops');
      const system = (key: string) => ({ key, permissions: [MIXED[1]!], source: 'vertical' as const, holder: 'system' as const });
      const refused = await failure(release([member, system('ops'), system('idle')]));
      expect(errorCodeOf(refused)).toBe('forbidden');
      // Round 4: a holder-less row is named as what it is, not as a person's role.
      expect(refused?.message).toMatch(/role 'ops' is held by a principal \(stored with no holder, from before holders were recorded \(#2480\)\)/);
      expect(refused?.message).not.toMatch(/stored as a person's role/);
      // The twin: the unseated legacy row upgrades.
      await release([member, system('idle')]);
      const holderOf = (key: string) =>
        runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_instance, state) =>
          (state.storage.sql.exec('SELECT holder FROM _substrat_roles WHERE tenant_id = ? AND role_key = ?', tenant, key).toArray()[0] as { holder: string } | undefined)?.holder);
      expect(await holderOf('idle')).toBe('system');
    });

    it('a system-held role dropped and added back while its host principal is seated is admitted: the tombstone is the stored definition it was (#2531)', async () => {
      const scope = scopeId.parse(ulid());
      const tenant = tenantId.parse(ulid());
      const owner = principalId.parse(ulid());
      const release = (roles: RoleDefinition[]) => local.provisionScopeLocal({ tenantId: tenant, scopeId: scope, owner, roles, ownerRoleKey: 'member' });
      await release([member, runner]);
      const hostPrincipal = principalId.parse(ulid());
      await local.assignScopeRole(scope, hostPrincipal, 'runner'); // the platform's door, K-55's shape
      await release([member, runner]); // an identical re-apply is admitted
      await release([member]); // the role dropped: tombstoned as system-held; the seat stays
      const state = await local.roleStateLocal(tenant, scope);
      expect(state.roles.map((r) => r.key)).toEqual(['member']);
      expect(state.dropped).toEqual([{ key: 'runner', permissions: [MIXED[1]], holder: 'system' }]);
      expect(state.seated).toContain('runner');
      await release([member, runner]); // added back: judged as the stored system-held row it was
      expect((await local.roleStateLocal(tenant, scope)).dropped).toEqual([]);
      expect((await local.roleStateLocal(tenant, scope)).roles.map((r) => r.key).sort()).toEqual(['member', 'runner']);
    });

    it('twin: the same drop and re-add with the tombstone gone is refused, saying what is true (round 3)', async () => {
      const scope = scopeId.parse(ulid());
      const tenant = tenantId.parse(ulid());
      const owner = principalId.parse(ulid());
      const release = (roles: RoleDefinition[]) => local.provisionScopeLocal({ tenantId: tenant, scopeId: scope, owner, roles, ownerRoleKey: 'member' });
      await release([member, runner]);
      const hostPrincipal = principalId.parse(ulid());
      await local.assignScopeRole(scope, hostPrincipal, 'runner');
      await release([member]);
      // A scope that dropped the row before tombstones were kept: the row is simply gone.
      await runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_instance, s) => {
        s.storage.sql.exec(`DELETE FROM _substrat_roles WHERE tenant_id = ? AND role_key = 'runner'`, tenant);
      });
      const refused = await failure(release([member, runner]));
      expect(errorCodeOf(refused)).toBe('forbidden');
      expect(refused?.message).toMatch(/role 'runner' is held by a principal \(with no definition stored\).*the seat may be a person's/);
      expect(refused?.message).toMatch(/Take that seat back first, wherever it is held \(a scope, or the tenant; a host principal's seat can be given again after\)/);
      expect(refused?.message).not.toMatch(/made through a person's door/);
      // The remedy the text names: take the seat back, add the role back, seat it again.
      await local.revokeScopeRole(scope, hostPrincipal, 'runner');
      await release([member, runner]);
      await local.assignScopeRole(scope, hostPrincipal, 'runner');
    });

    // This class reserves the key itself, so the refusal here does not depend on the tombstone; the
    // kernel's module-less case (`reserved-roles.test.ts`, #2531) is what holds the tombstone's half.
    it('a person’s role re-added under a dropped system-held role’s key may not hold its reserved key; its twin is defined (#2531)', async () => {
      const scope = scopeId.parse(ulid());
      const tenant = tenantId.parse(ulid());
      const owner = principalId.parse(ulid());
      const release = (roles: RoleDefinition[]) => local.provisionScopeLocal({ tenantId: tenant, scopeId: scope, owner, roles, ownerRoleKey: 'member' });
      await release([member, runner]);
      await release([member]);
      const asPerson = { key: 'runner', permissions: [MIXED[1]!], source: 'vertical' as const };
      const refused = await failure(release([member, asPerson]));
      expect(errorCodeOf(refused)).toBe('forbidden');
      expect(refused?.message).toMatch(/role 'runner' is a person's role and would hold rsv:run/);
      // Twin: re-added as a person's role without the reserved key, it is defined.
      await release([member, { key: 'runner', permissions: [MIXED[0]!], source: 'vertical' }]);
      expect((await local.roleStateLocal(tenant, scope)).roles.find((r) => r.key === 'runner')?.holder).toBe('person');
    });

    it('the table listing counts the roles in force apart from the tombstones, so health still sees an empty projection (#2531)', async () => {
      const scope = scopeId.parse(ulid());
      const tenant = tenantId.parse(ulid());
      const owner = principalId.parse(ulid());
      const staffer = { key: 'staffer', permissions: [MIXED[0]!], source: 'vertical' as const };
      await local.provisionScopeLocal({ tenantId: tenant, scopeId: scope, owner, roles: [member, staffer], ownerRoleKey: 'member' });
      await local.provisionScopeLocal({ tenantId: tenant, scopeId: scope, owner, roles: [member], ownerRoleKey: 'member' });
      const rolesTable = async () => (await local.introspectScopeTables(scope)).find((t) => t.name === '_substrat_roles');
      expect(await rolesTable()).toMatchObject({ rowCount: 2, liveRowCount: 1 });
      // Every role tombstoned: rows kept, nothing in force, which is what scope health flags (#321).
      await tombstoneProjectedRole(env.SCOPE.get(env.SCOPE.idFromName(scope)), tenant, 'member', new Date().toISOString());
      expect(await rolesTable()).toMatchObject({ rowCount: 2, liveRowCount: 0 });
      // A table that does not tombstone answers no live count.
      expect((await local.introspectScopeTables(scope)).find((t) => t.name === '_substrat_outbox')).not.toHaveProperty('liveRowCount');
    });

    it('a tombstone grants nothing: a seat in a dropped role authorizes as it did when the row was deleted, and again once it is added back (#2531)', async () => {
      const scope = scopeId.parse(ulid());
      const tenant = tenantId.parse(ulid());
      const owner = principalId.parse(ulid());
      const release = (roles: RoleDefinition[]) => local.provisionScopeLocal({ tenantId: tenant, scopeId: scope, owner, roles, ownerRoleKey: 'member' });
      const staffer = { key: 'staffer', permissions: [MIXED[0]!], source: 'vertical' as const };
      await release([member, staffer]);
      const who = principalId.parse(ulid());
      await local.assignScopeRole(scope, who, 'staffer');
      const role = () =>
        runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_instance, s) => createLocalControlPlaneReader(s.storage.sql).getRole(tenant, 'staffer'));
      const effective = () =>
        runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_instance, s) => {
          const q = effectiveRoleGrantQuery(tenant, new Date().toISOString(), `principal:${who}`);
          return (s.storage.sql.exec(q.sql, ...q.params).toArray()[0] as { effective: number }).effective;
        });
      expect((await role())?.permissions).toEqual([MIXED[0]]);
      expect(await effective()).toBe(1);
      await release([member]); // dropped: tombstoned, and expanded by nobody
      expect(await role()).toBeUndefined();
      expect(await effective()).toBe(0);
      expect(await local.hasScopeRoleLocal(tenant, scope, who)).toBe(false);
      await release([member, staffer]); // added back: the seat grants through it again
      expect((await role())?.permissions).toEqual([MIXED[0]]);
      expect(await effective()).toBe(1);
      expect(await local.hasScopeRoleLocal(tenant, scope, who)).toBe(true);
    });

    it('roleSetRefusalLocal answers the refusal a restore asks before importing, writing nothing; its twin answers null (round 1)', async () => {
      const scope = scopeId.parse(ulid());
      expect(await local.roleSetRefusalLocal(scope, [member, { key: 'mixed', permissions: MIXED, source: 'vertical' }])).toMatch(
        /role 'mixed' is a person's role and would hold rsv:run/,
      );
      expect(await local.roleSetRefusalLocal(scope, [member, runner])).toBeNull();
      expect(await rolesOf(scope)).toEqual([]);
      // Round 2: judged against the dump's own seats, which the scope will store once it is imported.
      const tenant = tenantId.parse(ulid());
      const flipped = { key: 'staffer', permissions: [MIXED[1]!], source: 'vertical' as const, holder: 'system' as const };
      const dump = {
        tenantId: tenant,
        tables: [
          {
            name: '_substrat_tuples',
            columns: ['subject', 'relation', 'object', 'expires_at', 'revoked_at'],
            rows: [[`principal:${ulid()}`, 'role:staffer', `scope:${scope}`, null, null]],
          },
        ],
      };
      expect(await local.roleSetRefusalLocal(scope, [member, flipped], dump)).toMatch(/role 'staffer' is held by a principal/);
      expect(await local.roleSetRefusalLocal(scope, [member, flipped])).toBeNull();
    });

    it('the owner hand-over’s person door refuses a system-held role that the platform’s door admits', async () => {
      const scope = scopeId.parse(ulid());
      await provision(scope, [member, runner], 'member');
      expect(await local.scopeRoleRefusal(scope, 'runner', 'person')).toMatch(/role 'runner' is declared holder: 'system'/);
      expect(await local.scopeRoleRefusal(scope, 'member', 'person')).toBeNull();
      const who = principalId.parse(ulid());
      expect(errorCodeOf(await failure(local.assignScopeRole(scope, who, 'runner', 'person')))).toBe('forbidden');
      expect(await grantedTo(scope, `principal:${who}`)).toEqual([]);
      // The twin: the platform's door seats a system-held role, K-55's shape.
      await local.assignScopeRole(scope, who, 'runner');
    });
  });

  // A scope with no receipt names its tenants only through its role rows, and the role is judged as
  // the checker reads it. These rows say the opposite of the control plane's definitions — a stale
  // projection — so which source decided is what each answer shows.
  describe('assignScopeRole on a scope with no provisioning receipt', () => {
    // `cp-mixed` and `cp-member` are defined in the describe's first hook, before the tenant's scope.
    /** A scope from before receipts: role rows projected for `t`, no receipt. */
    const stale = async () => {
      const bare = scopeId.parse(ulid());
      await projector(bare).projectRole(t, { key: 'cp-mixed', permissions: [MIXED[0]!], source: 'vertical' });
      await projector(bare).projectRole(t, { key: 'cp-member', permissions: MIXED, source: 'vertical' });
      return bare;
    };
    const assign = (scope: ScopeId, roleKey: string) =>
      host.assignScopeRole(scope, principalId.parse(ulid()), roleKey).then(() => null, (e: unknown) => errorCodeOf(e));

    it('reads the control plane’s definition while its checks do', async () => {
      const bare = await stale();
      expect(await assign(bare, 'cp-mixed')).toBe('forbidden');
      expect(await assign(bare, 'cp-member')).toBeNull();
    });

    it('…and its own rows once it reads locally', async () => {
      const bare = await stale();
      await runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(bare)), (_instance, state) => {
        state.storage.sql.exec(`INSERT OR REPLACE INTO _substrat_meta (key, value) VALUES ('permission_source', 'local')`);
      });
      expect(await assign(bare, 'cp-member')).toBe('forbidden');
      expect(await assign(bare, 'cp-mixed')).toBeNull();
    });

    it('judges every tenant its rows name, not only the first: a role mixed for the second tenant alone is refused', async () => {
      const bare = scopeId.parse(ulid());
      // Minted after `t`, so `t` sorts first and the mixed definition is the second tenant's.
      const second = tenantId.parse(ulid());
      await projector(bare).projectRole(t, { key: 'two', permissions: [MIXED[0]!], source: 'vertical' });
      await projector(bare).projectRole(second, { key: 'two', permissions: MIXED, source: 'vertical' });
      await runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(bare)), (_instance, state) => {
        state.storage.sql.exec(`INSERT OR REPLACE INTO _substrat_meta (key, value) VALUES ('permission_source', 'local')`);
      });
      expect(await assign(bare, 'two')).toBe('forbidden');
      // Its twin: a role both tenants define with person keys only.
      await projector(bare).projectRole(second, { key: 'one', permissions: [MIXED[0]!], source: 'vertical' });
      await projector(bare).projectRole(t, { key: 'one', permissions: [MIXED[0]!], source: 'vertical' });
      expect(await assign(bare, 'one')).toBeNull();
    });

    it('refuses when no role row names a tenant and its checks read the control plane; projecting one lets a person’s role through', async () => {
      const fresh = scopeId.parse(ulid());
      expect(await assign(fresh, 'cp-member')).toBe('forbidden');
      await projector(fresh).projectRole(t, { key: 'other', permissions: [MIXED[0]!], source: 'vertical' });
      expect(await assign(fresh, 'cp-member')).toBeNull();
    });
  });

  it('its twin: at the tenant node it reads its own reservations, which are none, so it assigns (a stated residual)', async () => {
    await host.admin.assignRole(staff, { principalId: principalId.parse(ulid()), roleKey: 'mixed', node: { tenantId: t, scopeId: null } });
  });

  /** A role row seeded straight into the scope's store: no receipt, and no host judgement. */
  function projector(scope: ScopeId) {
    const stub = env.SCOPE.get(env.SCOPE.idFromName(scope));
    return {
      projectRole: (tenantId: string, role: { key: string; permissions: string[]; source: string }) => seedProjectedRole(stub, tenantId, role),
    };
  }
  /** The `granted:` relations a subject (`principal:<id>`, `connection:<id>`) holds in a scope, read off its tuples. */
  function grantedTo(scope: ScopeId, subject: string) {
    return runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_instance, state) =>
      (state.storage.sql.exec(`SELECT relation FROM _substrat_tuples WHERE subject = ? AND revoked_at IS NULL ORDER BY relation`, subject).toArray() as { relation: string }[]).map((r) => r.relation),
    );
  }
});

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

// K-42 (#868): acting as a principal with the real actor preserved. The DEFAULT
// tuple checker, not allow-all — half of what this suite pins is that the door
// grants no authority of its own, and an allow-all checker would make the one
// test that proves it (a session against a principal who holds nothing) pass for
// the wrong reason.
impersonationContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

// #1672: capabilities, on the DO path — the ScopeDO's own SQLite holds the capability row,
// resolves the session inside its queue, and runs the kernel's checker branch; the
// coordinator hashes the session token and refuses a success the DO did not acknowledge.
// The DEFAULT tuple checker, for the impersonation suite's reason. `capMod` is in
// `contractTestModules`, so the ScopeDO carries it at code time. The expiry TRANSITIONS under
// an injected clock are the pure host's (`capabilityExpiryContractSuite`); the DO's own are
// the describe below.
capabilityContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

// #1686: the expiry TRANSITIONS on the DO path, with no clock seam. The DO host takes no
// clock (#956): the ScopeDO reads the wall clock itself, for the session door, the exchange
// and the checker alike. So time passes here the one way the DO's clock can see it: the
// stored instant is moved behind the wall clock, in the ScopeDO's own SQLite, past `ctx.sql`.
// The kernel compares that instant with `now` and nothing else, so an instant moved back
// is, to the DO, the instant reached. Each clock of `capabilityExpiryContractSuite` has its
// case here, and each its twin that is not yet past.
describe('capability expiry on the DO path, the stored instant past the wall clock (#1686)', () => {
  const CAP_READ = permissionKey.parse('cap:read');
  const HOUR = 60 * 60_000;
  const t1 = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  const alice = principalId.parse(ulid());
  const seat = principalId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const folder: EntityRef = { entityType: 'folder', entityId: 'F' };
  let host: CloudflareScopeHost;

  const scopeSql = (sql: string, ...params: SqlStorageValue[]) =>
    runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(s1)), (_, state) =>
      state.storage.sql.exec(sql, ...params).toArray(),
    );
  const aMinuteAgo = () => new Date(Date.now() - 60_000).toISOString();
  const later = () => instant.parse(new Date(Date.now() + HOUR).toISOString());
  const share = async (spec: Record<string, unknown>) =>
    (await host.getScope(alice, t1, s1)).invoke<MintedCapability>('cap/share', { entity: folder, permissions: [CAP_READ], ...spec });
  const session = async (secret: string): Promise<string> => {
    const ex = await host.exchangeCapability(t1, s1, secret);
    if (ex?.kind !== 'session') throw new Error(`expected a session, got ${JSON.stringify(ex)}`);
    return ex.sessionToken;
  };
  const read = async (token: string) => (await host.getCapabilityScope(token, t1, s1)).invoke('cap/read', { entity: folder });
  const refusal = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

  beforeAll(async () => {
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    host.registerModule(capMod);
    await host.admin.createTenant(staff, { id: t1, slug: `cap-do-expiry-${ulid().toLowerCase()}`, name: 'Cap DO expiry' });
    await host.admin.grantEntitlement(staff, t1, 'cap');
    await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'cap-vertical' });
    await host.admin.activateScope(staff, t1, s1);
    await host.admin.defineRole(staff, t1, { key: 'owner', permissions: [CAP_READ], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'owner', node: { tenantId: t1, scopeId: null } });
  });

  afterAll(async () => {
    await host.close();
  });

  it("a capability past its own expiry acts no more and exchanges no more; its sibling still does", async () => {
    const expiring = await share({ expiresAt: later() });
    const sibling = await share({ expiresAt: later() });
    const token = await session(expiring.secret);
    const siblingToken = await session(sibling.secret);
    await expect(read(token)).resolves.toBeTruthy();

    await scopeSql('UPDATE _substrat_capabilities SET expires_at = ? WHERE id = ?', aMinuteAgo(), expiring.id);
    // The session row still runs to the capability's original expiry: what refuses is the
    // capability's own instant, judged by the DO's clock.
    expect(errorCodeOf(await refusal(read(token)))).toBe('unauthenticated');
    expect(await host.exchangeCapability(t1, s1, expiring.secret)).toBeNull();

    await expect(read(siblingToken)).resolves.toBeTruthy();
    expect((await host.exchangeCapability(t1, s1, sibling.secret))?.kind).toBe('session');
  });

  it('a session past its TTL acts no more; the link itself exchanges again', async () => {
    const minted = await share({});
    const token = await session(minted.secret);
    const other = await session(minted.secret);
    await expect(read(token)).resolves.toBeTruthy();

    await scopeSql(
      'UPDATE _substrat_capability_sessions SET expires_at = ? WHERE token_hash = ?',
      aMinuteAgo(),
      await capabilityTokenHash(token),
    );
    expect(errorCodeOf(await refusal(read(token)))).toBe('unauthenticated');

    // The other session of the same capability is not past its TTL, and the link is not
    // past anything: both still act.
    await expect(read(other)).resolves.toBeTruthy();
    await expect(read(await session(minted.secret))).resolves.toBeTruthy();
  });

  it('a platform `become` past its expiry exchanges no more, and takes no use; its twin still does', async () => {
    const mint = () => host.admin.mintCapability(staff, t1, s1, { principal: seat, expiresAt: later(), maxUses: 5 });
    const expiring = await mint();
    const twin = await mint();

    await scopeSql('UPDATE _substrat_capabilities SET expires_at = ? WHERE id = ?', aMinuteAgo(), expiring.id);
    expect(await host.exchangeCapability(t1, s1, expiring.secret)).toBeNull();
    expect(await scopeSql('SELECT uses FROM _substrat_capabilities WHERE id = ?', expiring.id)).toEqual([{ uses: 0 }]);

    expect((await host.exchangeCapability(t1, s1, twin.secret))?.kind).toBe('principal');
  });
});

// #1686: a principal's `become` capability, on the DO path — the bound and the mint in one
// queued ScopeDO body, its event settled from the DO's own outbox, on workerd's SQLite.
becomeMintContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, verbs: host, cleanup: async () => host.close() };
});

// #1686: binding invites, on the DO path — the claim's bind and shape grant inside the ScopeDO's
// exchange transaction, the DEFAULT tuple checker judging the minter there.
bindingInviteContractSuite(
  'adapter-cloudflare',
  async () => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    return { host, verbs: host, cleanup: async () => host.close() };
  },
  // The scope DO's own storage, past `ctx.sql`.
  async (_tenant, scope, sql, params = []) =>
    runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_, state) =>
      state.storage.sql.exec(sql, ...(params as SqlStorageValue[])).toArray(),
    ),
);
