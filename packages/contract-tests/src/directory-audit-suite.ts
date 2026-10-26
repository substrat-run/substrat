import { describe, it, expect } from 'vitest';
import {
  connectionId, errorCodeOf, moduleId, orgId, permissionKey, platformActorId, principalId, scopeId, tenantId,
  type AdminAction, type OrgId, type PlatformActorId, type ScopeId, type TenantId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { heldMigrations } from './held-migrations.js';

/**
 * #2479: what a directory audit suite needs of an adapter — its host, and one statement run
 * against the directory its admin log lives in, so a fault is a trigger in the real store.
 */
export interface DirectoryAuditFixture {
  host: ScopeHost;
  directorySql(sql: string): Promise<void>;
  /** #2526: one read of the directory, for state no HostAdmin read answers (a tenant tuple). */
  directoryRows(sql: string): Promise<unknown[]>;
  /**
   * #2528: arm one statement to run against the directory, committed on its own, immediately
   * before the host's next audited directory write begins its unit — the write another caller
   * makes between whatever the host read first and the write. Runs once.
   */
  interleave(sql: string): void;
  cleanup(): Promise<void>;
}

/** A trigger refusing one admin action's row, or one kind of write to a directory table. */
function refusal(name: string, on: string, when = ''): { create: string; drop: string } {
  return {
    create: `CREATE TRIGGER ${name} BEFORE ${on} ${when}
      BEGIN SELECT RAISE(ABORT, 'refused by ${name} (test fault)'); END`,
    drop: `DROP TRIGGER IF EXISTS ${name}`,
  };
}

interface DirectoryCase {
  /** The admin action the write records. */
  action: AdminAction;
  /** The directory write the state statement is, refused in the reverse case. */
  write: { table: string; verb: 'INSERT' | 'UPDATE' | 'DELETE' };
  /** Arrange the world; answer the call, what it changes, and the row it must record. */
  arrange(host: ScopeHost, staff: PlatformActorId, fixture: DirectoryAuditFixture): Promise<{
    call(): Promise<unknown>;
    state(): Promise<unknown>;
    changed: unknown;
    row: { before: unknown; after: unknown };
  }>;
}

const slugOf = () => `audit-${ulid().toLowerCase()}`;

const newTenant = async (host: ScopeHost, staff: PlatformActorId, name = 'Audit directory test'): Promise<TenantId> => {
  const t = tenantId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: slugOf(), name });
  return t;
};

const newVertical = async (host: ScopeHost, staff: PlatformActorId): Promise<string> => {
  const slug = slugOf();
  await host.admin.registerVertical(staff, { slug, name: 'Audit directory test', source: 'builtin' });
  return slug;
};

const publish = async (host: ScopeHost, staff: PlatformActorId, slug: string): Promise<string> => {
  const id = ulid();
  await host.admin.publishVersion(staff, { id, verticalSlug: slug, version: `1.0.${id.toLowerCase()}`,
    manifestDigest: 'm', permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null });
  return id;
};

const verticalOf = async (host: ScopeHost, staff: PlatformActorId, slug: string) =>
  (await host.admin.listVerticals(staff)).find((v) => v.slug === slug);

/** #2501: how many of the slug's ownership periods are open (at most one). */
const openPeriodsOf = async (host: ScopeHost, staff: PlatformActorId, slug: string) =>
  (await host.admin.listVerticalOwners!(staff, slug)).filter((p) => p.until === null).length;

const AUDIT_READ = permissionKey.parse('audit:read');

/** #2526: how many live tenant tuples hold `relation` for `subject`. */
const tenantTuples = async (f: DirectoryAuditFixture, t: TenantId, subject: string, relation: string): Promise<number> =>
  (await f.directoryRows(`SELECT 1 FROM _substrat_tenant_tuples WHERE tenant_id = '${t}' AND subject = '${subject}'
     AND relation = '${relation}' AND revoked_at IS NULL`)).length;

const newOrg = async (host: ScopeHost, staff: PlatformActorId, t: TenantId): Promise<OrgId> => {
  const id = orgId.parse(ulid());
  await host.admin.createOrg(staff, { id, tenantId: t, slug: slugOf(), name: 'Audit org' });
  return id;
};

/** #2526: a live connection in tenant `t`, for vertical `vertical`. */
const newConnection = async (host: ScopeHost, staff: PlatformActorId, t: TenantId, vertical = 'audit-vertical') => {
  const id = connectionId.parse(ulid());
  const provider = `audit-${id.toLowerCase()}`;
  await host.admin.createConnection(staff, { id, tenantId: t, vertical, provider, label: 'Audit connection', secret: { accessToken: 'tok' } });
  return { id, provider };
};

/** #2526: a provisioned scope in tenant `t`, with a lowercase hostname of its own to bind. */
const newScope = async (host: ScopeHost, staff: PlatformActorId, t: TenantId) => {
  const s = scopeId.parse(ulid());
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: await newVertical(host, staff) });
  return s;
};

const hostnameOf = () => `audit-${ulid().toLowerCase()}.example.com`;

/**
 * #2526: a hostname bound to scope `s` of tenant `t`, `pending` as a bind leaves it. Bound by an
 * actor of its own, so its row is never one a case counts as the call's.
 */
const bound = async (host: ScopeHost, t: TenantId, s: ScopeId, canonical = false): Promise<string> => {
  const hostname = hostnameOf();
  await host.admin.bindHostname(platformActorId.parse(ulid()), { hostname, tenantId: t, scopeId: s, surface: 'app', region: null, canonical });
  return hostname;
};

/** #2526: a scope's hostnames as `[hostname, canonical]`, in name order. */
const scopeHostnames = async (host: ScopeHost, staff: PlatformActorId, s: ScopeId) =>
  (await host.admin.listHostnames(staff, { scopeId: s })).map((h) => [h.hostname, h.canonical]).sort();

const hostnameStatus = async (host: ScopeHost, staff: PlatformActorId, s: ScopeId, hostname: string) =>
  (await host.admin.listHostnames(staff, { scopeId: s })).find((h) => h.hostname === hostname)?.status ?? null;

const RECORDS = [{ type: 'txt' as const, name: '_cf-custom-hostname', value: 'dcv-token', status: null }];

const entitlementsOf = async (host: ScopeHost, staff: PlatformActorId, t: TenantId) =>
  (await host.admin.listEntitlements(staff, t)).map((e) => [e.entitlementKey, e.plan]);

/** One vertical flag flipped by staff: the case is the same shape for each. */
const flagCase = (
  action: 'setVerticalListed' | 'setVerticalInstallsBlocked' | 'setVerticalTenantProvisioner' | 'setVerticalEmailSender',
  field: 'listed' | 'installsBlocked' | 'tenantProvisioner' | 'emailSender',
): DirectoryCase => ({
  action,
  write: { table: 'verticals', verb: 'UPDATE' },
  arrange: async (host, staff) => {
    const slug = await newVertical(host, staff);
    return {
      call: () => host.admin[action](staff, slug, true),
      state: async () => (await verticalOf(host, staff, slug))?.[field],
      changed: true,
      row: { before: { [field]: false }, after: { [field]: true } },
    };
  },
});

const CASES: DirectoryCase[] = [
  {
    action: 'createTenant',
    write: { table: 'tenants', verb: 'INSERT' },
    arrange: async (host, staff) => {
      const t = tenantId.parse(ulid());
      const slug = slugOf();
      return {
        call: () => host.admin.createTenant(staff, { id: t, slug, name: 'Created' }),
        state: async () => (await host.admin.getTenant(staff, t))?.status ?? null,
        changed: 'active',
        row: { before: null, after: expect.objectContaining({ id: t, slug, name: 'Created', status: 'active' }) },
      };
    },
  },
  {
    action: 'setTenantStatus',
    write: { table: 'tenants', verb: 'UPDATE' },
    arrange: async (host, staff) => {
      const t = await newTenant(host, staff);
      return {
        call: () => host.admin.setTenantStatus(staff, t, 'suspended'),
        state: async () => (await host.admin.getTenant(staff, t))?.status,
        changed: 'suspended',
        row: { before: { status: 'active' }, after: { status: 'suspended' } },
      };
    },
  },
  {
    action: 'setTenantName',
    write: { table: 'tenants', verb: 'UPDATE' },
    arrange: async (host, staff) => {
      const t = await newTenant(host, staff, 'Before');
      return {
        call: () => host.admin.setTenantName(staff, t, 'After'),
        state: async () => (await host.admin.getTenant(staff, t))?.name,
        changed: 'After',
        row: { before: { name: 'Before' }, after: { name: 'After' } },
      };
    },
  },
  {
    action: 'reapTenant',
    write: { table: 'tenants', verb: 'UPDATE' },
    arrange: async (host, staff) => {
      const t = await newTenant(host, staff);
      await host.admin.grantEntitlement(staff, t, 'audit-entitlement');
      await host.admin.setTenantStatus(staff, t, 'deleting');
      return {
        call: () => host.admin.reapTenant(staff, t),
        // The rows a reap clears go back with the flip: the entitlement is the witness.
        state: async () => [(await host.admin.getTenant(staff, t))?.status, (await host.admin.listEntitlements(staff, t)).length],
        changed: ['reaped', 0],
        row: { before: { status: 'deleting' }, after: { status: 'reaped' } },
      };
    },
  },
  {
    action: 'registerVertical',
    write: { table: 'verticals', verb: 'INSERT' },
    arrange: async (host, staff) => {
      const slug = slugOf();
      return {
        call: () => host.admin.registerVertical(staff, { slug, name: 'Registered', source: 'builtin' }),
        // #2501: the ownership period opens in the same unit as the row and its admin entry.
        state: async () => [(await verticalOf(host, staff, slug))?.name ?? null, await openPeriodsOf(host, staff, slug)],
        changed: ['Registered', 1],
        row: { before: null, after: expect.objectContaining({ slug, name: 'Registered', source: 'builtin' }) },
      };
    },
  },
  {
    action: 'publishVersion',
    write: { table: 'vertical_versions', verb: 'INSERT' },
    arrange: async (host, staff) => {
      const slug = await newVertical(host, staff);
      const id = ulid();
      return {
        call: () => host.admin.publishVersion(staff, { id, verticalSlug: slug, version: `1.0.${id.toLowerCase()}`,
          manifestDigest: 'm', permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null }),
        state: async () => (await host.admin.getVersion(staff, id))?.admission ?? null,
        changed: 'pending',
        row: { before: null, after: expect.objectContaining({ id, verticalSlug: slug, admission: 'pending' }) },
      };
    },
  },
  flagCase('setVerticalListed', 'listed'),
  {
    action: 'requestPublish',
    write: { table: 'verticals', verb: 'UPDATE' },
    arrange: async (host, staff) => {
      const slug = await newVertical(host, staff);
      return {
        call: () => host.admin.requestPublish(staff, slug),
        state: async () => (await verticalOf(host, staff, slug))?.publishRequestedAt != null,
        changed: true,
        row: { before: null, after: { slug } },
      };
    },
  },
  flagCase('setVerticalInstallsBlocked', 'installsBlocked'),
  flagCase('setVerticalTenantProvisioner', 'tenantProvisioner'),
  flagCase('setVerticalEmailSender', 'emailSender'),
  {
    action: 'deleteVertical',
    write: { table: 'verticals', verb: 'DELETE' },
    arrange: async (host, staff) => {
      const slug = await newVertical(host, staff);
      const version = await publish(host, staff, slug);
      return {
        call: () => host.admin.deleteVertical(staff, slug),
        // The versions it deletes first go back with the row, and so does the closing of its
        // ownership period (#2501).
        state: async () => [
          (await verticalOf(host, staff, slug)) !== undefined,
          (await host.admin.getVersion(staff, version)) !== undefined,
          await openPeriodsOf(host, staff, slug),
        ],
        changed: [false, false, 0],
        row: { before: { slug, source: 'builtin', ownerTenant: null }, after: null },
      };
    },
  },
  {
    action: 'admitVersion',
    write: { table: 'vertical_versions', verb: 'UPDATE' },
    arrange: async (host, staff) => {
      const version = await publish(host, staff, await newVertical(host, staff));
      return {
        call: () => host.admin.admitVersion(staff, version),
        state: async () => (await host.admin.getVersion(staff, version))?.admission,
        changed: 'admitted',
        row: { before: { admission: 'pending' }, after: { admission: 'admitted' } },
      };
    },
  },
  {
    action: 'rejectVersion',
    write: { table: 'vertical_versions', verb: 'UPDATE' },
    arrange: async (host, staff) => {
      const version = await publish(host, staff, await newVertical(host, staff));
      return {
        call: () => host.admin.rejectVersion(staff, version, 'not this one'),
        state: async () => (await host.admin.getVersion(staff, version))?.admission,
        changed: 'rejected',
        row: { before: { admission: 'pending' }, after: { admission: 'rejected', note: 'not this one' } },
      };
    },
  },
  {
    action: 'promoteVersion',
    write: { table: 'vertical_channels', verb: 'INSERT' },
    arrange: async (host, staff) => {
      const slug = await newVertical(host, staff);
      const version = await publish(host, staff, slug);
      await host.admin.admitVersion(staff, version);
      return {
        call: () => host.admin.promoteVersion(staff, slug, 'prod', version),
        state: async () => (await host.admin.listChannels(staff, slug))[0]?.versionId ?? null,
        changed: version,
        row: { before: null, after: expect.objectContaining({ channel: 'prod', versionId: version }) },
      };
    },
  },
  {
    action: 'setVerticalServing',
    write: { table: 'verticals', verb: 'UPDATE' },
    arrange: async (host, staff) => {
      const slug = await newVertical(host, staff);
      const version = await publish(host, staff, slug);
      const ref = `serving-${ulid().toLowerCase()}`;
      return {
        call: () => host.admin.setVerticalServing(staff, slug, { ref, versionId: version, doClasses: [], migrationTag: 'g' }),
        state: async () => (await host.admin.verticalServing(staff, slug))?.versionId ?? null,
        changed: version,
        row: { before: null, after: { vertical: slug, ref, versionId: version } },
      };
    },
  },
  {
    // RFC wire-signing §7 (Q8): the capability record of one upload.
    action: 'recordWireAuth',
    write: { table: 'vertical_wire_auth', verb: 'INSERT' },
    arrange: async (host, staff) => {
      // A record is written only beside its vertical's registration.
      const slug = await newVertical(host, staff);
      const deploymentRef = `${slug}-serving`;
      const record = {
        envelope: 1 as const, entrySkipped: null, state: 'dual' as const, audience: deploymentRef,
        routerKids: ['If4x36FUomE'], platformKids: ['OfcT0KZEJT8'], withheld: null,
      };
      return {
        call: () => host.admin.recordWireAuth!(staff, { deploymentRef, verticalSlug: slug, versionId: 'v1', record, recordedAt: '2026-10-24T10:00:00.000Z' }),
        state: async () => (await host.admin.listWireAuth!(staff, { reach: { fleet: true }, limit: 1, verticalSlug: slug }))[0]?.record ?? null,
        changed: record,
        row: { before: null, after: { vertical: slug, deploymentRef, versionId: 'v1', record } },
      };
    },
  },
  // #2526: the role, grant and org writes at a tenant node.
  {
    action: 'defineRole',
    write: { table: '_substrat_roles', verb: 'INSERT' },
    arrange: async (host, staff) => {
      const t = await newTenant(host, staff);
      return {
        call: () => host.admin.defineRole(staff, t, { key: 'auditor', permissions: [AUDIT_READ], source: 'vertical' }),
        state: async () => (await host.admin.listRoles(staff, { tenantId: t })).find((r) => r.key === 'auditor')?.permissions ?? null,
        changed: [AUDIT_READ],
        row: { before: null, after: expect.objectContaining({ key: 'auditor', permissions: [AUDIT_READ], source: 'vertical' }) },
      };
    },
  },
  {
    action: 'assignRole',
    write: { table: '_substrat_tenant_tuples', verb: 'INSERT' },
    arrange: async (host, staff, fixture) => {
      const t = await newTenant(host, staff);
      await host.admin.defineRole(staff, t, { key: 'auditor', permissions: [AUDIT_READ], source: 'vertical' });
      const assignment = { principalId: principalId.parse(ulid()), roleKey: 'auditor', node: { tenantId: t, scopeId: null } };
      return {
        call: () => host.admin.assignRole(staff, assignment),
        state: () => tenantTuples(fixture, t, `principal:${assignment.principalId}`, 'role:auditor'),
        changed: 1,
        row: { before: null, after: assignment },
      };
    },
  },
  {
    action: 'grant',
    write: { table: '_substrat_tenant_tuples', verb: 'INSERT' },
    arrange: async (host, staff, fixture) => {
      const t = await newTenant(host, staff);
      const who = principalId.parse(ulid());
      return {
        call: () => host.admin.grant(staff, { principalId: who, permission: AUDIT_READ, node: { tenantId: t, scopeId: null }, grantedBy: who }),
        state: () => tenantTuples(fixture, t, `principal:${who}`, `granted:${AUDIT_READ}`),
        changed: 1,
        row: { before: null, after: expect.objectContaining({ principalId: who, permission: AUDIT_READ }) },
      };
    },
  },
  {
    action: 'grantToOrg',
    write: { table: '_substrat_tenant_tuples', verb: 'INSERT' },
    arrange: async (host, staff, fixture) => {
      const t = await newTenant(host, staff);
      const org = await newOrg(host, staff, t);
      return {
        call: () => host.admin.grantToOrg(staff, org, AUDIT_READ, { tenantId: t, scopeId: null }),
        state: () => tenantTuples(fixture, t, `org:${org}`, `granted:${AUDIT_READ}`),
        changed: 1,
        row: { before: null, after: { orgId: org, permission: AUDIT_READ, node: { tenantId: t, scopeId: null } } },
      };
    },
  },
  {
    action: 'grantToSystem',
    write: { table: '_substrat_tenant_tuples', verb: 'INSERT' },
    arrange: async (host, staff, fixture) => {
      const t = await newTenant(host, staff);
      const mod = moduleId.parse('audit-module');
      const node = { tenantId: t, scopeId: null };
      return {
        call: () => host.admin.grantToSystem(staff, { moduleId: mod, permission: AUDIT_READ, node, grantedBy: staff }),
        state: () => tenantTuples(fixture, t, `system:${mod}`, `granted:${AUDIT_READ}`),
        changed: 1,
        row: { before: null, after: { moduleId: mod, permission: AUDIT_READ, node } },
      };
    },
  },
  {
    action: 'grantToConnection',
    write: { table: '_substrat_connection_grants', verb: 'INSERT' },
    arrange: async (host, staff, fixture) => {
      const t = await newTenant(host, staff);
      const conn = await newConnection(host, staff, t);
      const node = { tenantId: t, scopeId: null };
      return {
        call: () => host.admin.grantToConnection(staff, { connectionId: conn.id, permission: AUDIT_READ, node, grantedBy: staff }),
        // The record and, at the tenant node, the tuple go back together.
        state: async () => [
          (await host.admin.listConnectionGrants(staff, t)).filter((g) => g.connectionId === conn.id).length,
          await tenantTuples(fixture, t, `connection:${conn.id}`, `granted:${AUDIT_READ}`),
        ],
        changed: [1, 1],
        row: { before: null, after: { connectionId: conn.id, provider: conn.provider, permission: AUDIT_READ, node } },
      };
    },
  },
  {
    action: 'createOrg',
    write: { table: 'orgs', verb: 'INSERT' },
    arrange: async (host, staff) => {
      const t = await newTenant(host, staff);
      const id = orgId.parse(ulid());
      const slug = slugOf();
      return {
        call: () => host.admin.createOrg(staff, { id, tenantId: t, slug, name: 'Created org' }),
        state: async () => (await host.admin.getOrg(staff, t, id))?.slug ?? null,
        changed: slug,
        row: { before: null, after: expect.objectContaining({ id, tenantId: t, slug, name: 'Created org' }) },
      };
    },
  },
  {
    action: 'addMember',
    write: { table: '_substrat_tenant_tuples', verb: 'INSERT' },
    arrange: async (host, staff) => {
      const t = await newTenant(host, staff);
      const org = await newOrg(host, staff, t);
      const who = principalId.parse(ulid());
      return {
        call: () => host.admin.addMember(staff, t, who, org),
        state: async () => (await host.admin.listMembers(staff, t, org)).map((m) => m.principal),
        changed: [who],
        row: { before: null, after: expect.objectContaining({ principal: who, orgId: org }) },
      };
    },
  },
  // #2526: the hostname and entitlement writes.
  {
    action: 'bindHostname',
    write: { table: 'hostnames', verb: 'INSERT' },
    arrange: async (host, staff) => {
      const t = await newTenant(host, staff);
      const s = await newScope(host, staff, t);
      // The surface's canonical already: the new canonical demotes it in the same unit, so a
      // refused bind leaves it canonical, whichever write is refused.
      const first = await bound(host, t, s, true);
      const hostname = hostnameOf();
      return {
        call: () => host.admin.bindHostname(staff, { hostname, tenantId: t, scopeId: s, surface: 'app', region: null, canonical: true }),
        state: () => scopeHostnames(host, staff, s),
        changed: [[first, false], [hostname, true]].sort(),
        row: { before: null, after: expect.objectContaining({ hostname, tenantId: t, scopeId: s, surface: 'app', canonical: true }) },
      };
    },
  },
  {
    action: 'setHostnameStatus',
    write: { table: 'hostnames', verb: 'UPDATE' },
    arrange: async (host, staff) => {
      const t = await newTenant(host, staff);
      const s = await newScope(host, staff, t);
      const hostname = await bound(host, t, s);
      return {
        call: () => host.admin.setHostnameStatus(staff, hostname, 'active'),
        state: () => hostnameStatus(host, staff, s, hostname),
        changed: 'active',
        row: { before: { status: 'pending' }, after: { status: 'active', note: null } },
      };
    },
  },
  {
    action: 'setHostnameIssuance',
    write: { table: 'hostnames', verb: 'UPDATE' },
    arrange: async (host, staff) => {
      const t = await newTenant(host, staff);
      const s = await newScope(host, staff, t);
      const hostname = await bound(host, t, s);
      return {
        call: () => host.admin.setHostnameIssuance(staff, hostname, { status: 'verifying', customHostnameId: 'cf-audit', validationRecords: RECORDS }),
        state: () => hostnameStatus(host, staff, s, hostname),
        changed: 'verifying',
        row: { before: { status: 'pending' }, after: { status: 'verifying', note: null } },
      };
    },
  },
  {
    action: 'unbindHostname',
    write: { table: 'hostnames', verb: 'DELETE' },
    arrange: async (host, staff) => {
      const t = await newTenant(host, staff);
      const s = await newScope(host, staff, t);
      const hostname = await bound(host, t, s);
      return {
        call: () => host.admin.unbindHostname(staff, hostname),
        state: () => scopeHostnames(host, staff, s),
        changed: [],
        row: { before: { hostname, status: 'pending' }, after: null },
      };
    },
  },
  {
    action: 'grantEntitlement',
    write: { table: '_substrat_entitlements', verb: 'INSERT' },
    arrange: async (host, staff) => {
      const t = await newTenant(host, staff);
      return {
        call: () => host.admin.grantEntitlement(staff, t, 'audit-entitlement', { plan: 'pro' }),
        state: () => entitlementsOf(host, staff, t),
        changed: [['audit-entitlement', 'pro']],
        row: { before: null, after: { entitlementKey: 'audit-entitlement', expiresAt: null, quota: null, plan: 'pro' } },
      };
    },
  },
  {
    action: 'revokeEntitlement',
    write: { table: '_substrat_entitlements', verb: 'DELETE' },
    arrange: async (host, staff) => {
      const t = await newTenant(host, staff);
      await host.admin.grantEntitlement(staff, t, 'audit-entitlement', { plan: 'pro' });
      return {
        call: () => host.admin.revokeEntitlement(staff, t, 'audit-entitlement'),
        state: () => entitlementsOf(host, staff, t),
        changed: [],
        row: { before: { entitlementKey: 'audit-entitlement', expiresAt: null, quota: null, plan: 'pro' }, after: null },
      };
    },
  },
];

/**
 * #2479: every tenant and vertical directory write commits with its admin row. A fault in the
 * audit insert leaves the state as it was and no row; a fault in the state write leaves no row;
 * the retry writes the state and exactly one row, fields as the adapters have always written them.
 */
export function directoryAdminAuditTransactionSuite(adapterName: string, makeFixture: () => Promise<DirectoryAuditFixture>): void {
  describe(`HostAdmin tenant and vertical directory audit transaction: ${adapterName}`, () => {
    const run = async (c: DirectoryCase, fault: 'audit' | 'write') => {
      const fixture = await makeFixture();
      const { host } = fixture;
      const staff = platformActorId.parse(ulid());
      const tag = `${c.action.toLowerCase()}_${ulid().toLowerCase()}`;
      const trigger = fault === 'audit'
        ? refusal(`test_refuse_audit_${tag}`, 'INSERT ON _substrat_admin_log', `WHEN NEW.action = '${c.action}'`)
        : refusal(`test_refuse_write_${tag}`, `${c.write.verb} ON ${c.write.table}`);
      let lifted = true;
      try {
        const { call, state, changed, row } = await c.arrange(host, staff, fixture);
        const since = new Date().toISOString();
        // The call's own rows: an arrangement that made the same action as another actor, in the
        // same millisecond as `since`, is not one of them.
        const rows = async () => (await host.admin.auditLog(staff, { action: [c.action], since })).filter((r) => r.actor === staff);
        const before = await state();
        expect(before).not.toEqual(changed);
        await fixture.directorySql(trigger.create);
        lifted = false;
        await expect(call()).rejects.toThrow(/test fault/);
        expect(await state()).toEqual(before);
        expect(await rows()).toEqual([]);
        await fixture.directorySql(trigger.drop);
        lifted = true;
        await call();
        expect(await state()).toEqual(changed);
        expect((await rows()).map((r) => ({ before: r.before, after: r.after }))).toEqual([row]);
      } finally {
        if (!lifted) await fixture.directorySql(trigger.drop);
        await fixture.cleanup();
      }
    };

    it.each(CASES.map((c) => [c.action, c] as const))('%s rolls back when its audit row is refused, and writes one on retry', async (_, c) => {
      await run(c, 'audit');
    });

    it.each(CASES.map((c) => [c.action, c] as const))('%s records no audit row when its state write is refused', async (_, c) => {
      await run(c, 'write');
    });

    it('a no-op rename records nothing, and the rename before it one row', async () => {
      const fixture = await makeFixture();
      const { host } = fixture;
      const staff = platformActorId.parse(ulid());
      try {
        const t = await newTenant(host, staff, 'Before');
        await host.admin.setTenantName(staff, t, 'After');
        await host.admin.setTenantName(staff, t, 'After');
        expect((await host.admin.auditLog(staff, { tenantId: t, action: ['setTenantName'] })).map((r) => r.after))
          .toEqual([{ name: 'After' }]);
      } finally {
        await fixture.cleanup();
      }
    });

    // The promote's own row commits with the channel move, so it lands ahead of the rebinds a
    // private promote makes afterwards, each of which records its own row.
    it('a private promote records its own row before the scope rebinds it causes', async () => {
      const fixture = await makeFixture();
      const { host } = fixture;
      const staff = platformActorId.parse(ulid());
      try {
        const owner = await newTenant(host, staff);
        const scope = scopeId.parse(ulid());
        const slug = `tenant-a/${slugOf()}`;
        await host.admin.registerVertical(staff, { slug, name: 'Audit promote order', source: 'cli', ownerTenant: owner });
        const release = async () => {
          const id = ulid();
          await host.admin.publishVersion(staff, { id, verticalSlug: slug, version: `1.0.${id.toLowerCase()}`,
            manifestDigest: 'm', permissionDigest: 'p', ...(await heldMigrations('g')), deploymentRef: null });
          return id;
        };
        const first = await release();
        const second = await release();
        await host.provisionScope(staff, { tenantId: owner, scopeId: scope, vertical: slug });
        await host.admin.activateScope(staff, owner, scope);
        await host.admin.bindScopeVersion(staff, owner, scope, first);
        await host.admin.promoteVersion(staff, slug, 'prod', first);
        await host.admin.promoteVersion(staff, slug, 'prod', second);
        // In id order, which is the order they were written.
        const rows = (await host.admin.auditLog(staff, { action: ['promoteVersion', 'bindScopeVersion'] }))
          .filter((r) => (r.vertical === slug || r.scopeId === scope) && (r.after as { versionId: string }).versionId === second);
        expect(rows.map((r) => [r.action, (r.after as { versionId: string }).versionId])).toEqual([
          ['promoteVersion', second],
          ['bindScopeVersion', second],
        ]);
        expect((await host.admin.getScopeRecord(staff, owner, scope))?.verticalVersionId).toBe(second);
      } finally {
        await fixture.cleanup();
      }
    });

    describe('#2528: the row and the guard are read in the unit that writes', () => {
      const withFixture = async (body: (f: DirectoryAuditFixture, host: ScopeHost, staff: PlatformActorId) => Promise<void>) => {
        const fixture = await makeFixture();
        try {
          await body(fixture, fixture.host, platformActorId.parse(ulid()));
        } finally {
          await fixture.cleanup();
        }
      };
      const refusalOf = async (p: Promise<unknown>): Promise<Error> => {
        try {
          await p;
        } catch (err) {
          return err as Error;
        }
        throw new Error('expected the call to be refused');
      };
      const rowsSince = async (host: ScopeHost, staff: PlatformActorId, action: AdminAction, since: string) =>
        (await host.admin.auditLog(staff, { action: [action], since }))
          .filter((r) => r.actor === staff)
          .map((r) => ({ before: r.before, after: r.after }));
      /** A private vertical (tenant-owned, not listed), whose versions self-admit. */
      const privateVertical = async (host: ScopeHost, staff: PlatformActorId) => {
        const owner = await newTenant(host, staff);
        const slug = `tenant-a/${slugOf()}`;
        await host.admin.registerVertical(staff, { slug, name: 'Audit private', source: 'cli', ownerTenant: owner });
        const release = async () => {
          const id = ulid();
          await host.admin.publishVersion(staff, { id, verticalSlug: slug, version: `1.0.${id.toLowerCase()}`,
            manifestDigest: 'm', permissionDigest: 'p', ...(await heldMigrations('g')), deploymentRef: null });
          return id;
        };
        return { slug, release };
      };

      const FLAGS = [
        ['setVerticalListed', 'listed', 'listed'],
        ['setVerticalInstallsBlocked', 'installsBlocked', 'installs_blocked'],
        ['setVerticalTenantProvisioner', 'tenantProvisioner', 'tenant_provisioner'],
        ['setVerticalEmailSender', 'emailSender', 'email_sender'],
      ] as const;
      it.each(FLAGS)('%s records the before its own unit read', async (action, field, column) => {
        await withFixture(async (fixture, host, staff) => {
          const slug = await newVertical(host, staff);
          const since = new Date().toISOString();
          fixture.interleave(`UPDATE verticals SET ${column} = 1 WHERE slug = '${slug}'`);
          await host.admin[action](staff, slug, false);
          expect((await verticalOf(host, staff, slug))?.[field]).toBe(false);
          expect(await rowsSince(host, staff, action, since)).toEqual([{ before: { [field]: true }, after: { [field]: false } }]);
        });
      });

      it('listing refuses an auto-admitted prod version a promote moved the channel to', async () => {
        await withFixture(async (fixture, host, staff) => {
          const { slug, release } = await privateVertical(host, staff);
          const vouched = await release();
          await host.admin.admitVersion(staff, vouched);
          await host.admin.promoteVersion(staff, slug, 'prod', vouched);
          const auto = await release();
          const since = new Date().toISOString();
          fixture.interleave(`UPDATE vertical_channels SET version_id = '${auto}' WHERE vertical_slug = '${slug}' AND channel = 'prod'`);
          const refused = await refusalOf(host.admin.setVerticalListed(staff, slug, true));
          expect(errorCodeOf(refused)).toBe('conflict');
          expect(refused.message).toContain(`prod version ${auto} is auto-admitted`);
          expect((await verticalOf(host, staff, slug))?.listed).toBe(false);
          expect(await rowsSince(host, staff, 'setVerticalListed', since)).toEqual([]);
        });
      });

      it('and lists when the channel moved from an auto-admitted version to a vouched one', async () => {
        await withFixture(async (fixture, host, staff) => {
          const { slug, release } = await privateVertical(host, staff);
          const vouched = await release();
          await host.admin.admitVersion(staff, vouched);
          const auto = await release();
          await host.admin.promoteVersion(staff, slug, 'prod', auto);
          const since = new Date().toISOString();
          fixture.interleave(`UPDATE vertical_channels SET version_id = '${vouched}' WHERE vertical_slug = '${slug}' AND channel = 'prod'`);
          await host.admin.setVerticalListed(staff, slug, true);
          expect((await verticalOf(host, staff, slug))?.listed).toBe(true);
          expect(await rowsSince(host, staff, 'setVerticalListed', since)).toEqual([{ before: { listed: false }, after: { listed: true } }]);
        });
      });

      it('admitVersion refuses a version rejected since it was read', async () => {
        await withFixture(async (fixture, host, staff) => {
          const version = await publish(host, staff, await newVertical(host, staff));
          const since = new Date().toISOString();
          fixture.interleave(`UPDATE vertical_versions SET admission = 'rejected', admission_note = 'interleaved' WHERE id = '${version}'`);
          const refused = await refusalOf(host.admin.admitVersion(staff, version));
          expect(errorCodeOf(refused)).toBe('conflict');
          expect(refused.message).toBe(`version ${version} was rejected — publish a new one`);
          expect((await host.admin.getVersion(staff, version))?.admission).toBe('rejected');
          expect(await rowsSince(host, staff, 'admitVersion', since)).toEqual([]);
        });
      });

      it('rejectVersion refuses a version admitted since it was read', async () => {
        await withFixture(async (fixture, host, staff) => {
          const version = await publish(host, staff, await newVertical(host, staff));
          const since = new Date().toISOString();
          fixture.interleave(`UPDATE vertical_versions SET admission = 'admitted' WHERE id = '${version}'`);
          const refused = await refusalOf(host.admin.rejectVersion(staff, version, 'not this one'));
          expect(errorCodeOf(refused)).toBe('conflict');
          expect(refused.message).toBe(`version ${version} is already admitted — it may be bound`);
          expect((await host.admin.getVersion(staff, version))?.admission).toBe('admitted');
          expect(await rowsSince(host, staff, 'rejectVersion', since)).toEqual([]);
        });
      });

      it('admitVersion of an auto-admitted version another admit already vouched for records nothing', async () => {
        await withFixture(async (fixture, host, staff) => {
          const { release } = await privateVertical(host, staff);
          const auto = await release();
          const since = new Date().toISOString();
          fixture.interleave(`UPDATE vertical_versions SET admission_note = NULL WHERE id = '${auto}'`);
          await host.admin.admitVersion(staff, auto);
          expect((await host.admin.getVersion(staff, auto))?.admissionNote).toBeNull();
          expect(await rowsSince(host, staff, 'admitVersion', since)).toEqual([]);
        });
      });

      it('deleteVertical refuses a vertical a scope was bound to since it was read', async () => {
        await withFixture(async (fixture, host, staff) => {
          const slug = await newVertical(host, staff);
          const other = await newVertical(host, staff);
          const t = await newTenant(host, staff);
          const s = scopeId.parse(ulid());
          await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: other });
          const since = new Date().toISOString();
          fixture.interleave(`UPDATE scopes SET vertical = '${slug}' WHERE scope_id = '${s}'`);
          const refused = await refusalOf(host.admin.deleteVertical(staff, slug));
          expect(errorCodeOf(refused)).toBe('conflict');
          expect(refused.message).toBe(`vertical '${slug}' still backs 1 scope(s) — delete or rebind them first`);
          expect(await verticalOf(host, staff, slug)).toBeDefined();
          expect(await rowsSince(host, staff, 'deleteVertical', since)).toEqual([]);
        });
      });

      it('publishVersion does not self-admit on a vertical listed since it was read', async () => {
        await withFixture(async (fixture, host, staff) => {
          const { slug, release } = await privateVertical(host, staff);
          const since = new Date().toISOString();
          fixture.interleave(`UPDATE verticals SET listed = 1 WHERE slug = '${slug}'`);
          const version = await release();
          expect(await host.admin.getVersion(staff, version)).toMatchObject({ admission: 'pending', admissionNote: null });
          expect((await rowsSince(host, staff, 'publishVersion', since)).map((r) => (r.after as { admission: string }).admission))
            .toEqual(['pending']);
        });
      });

      it('and self-admits on a vertical unlisted since it was read', async () => {
        await withFixture(async (fixture, host, staff) => {
          const { slug, release } = await privateVertical(host, staff);
          await fixture.directorySql(`UPDATE verticals SET listed = 1 WHERE slug = '${slug}'`);
          const since = new Date().toISOString();
          fixture.interleave(`UPDATE verticals SET listed = 0 WHERE slug = '${slug}'`);
          const version = await release();
          expect(await host.admin.getVersion(staff, version)).toMatchObject({ admission: 'admitted', admissionNote: expect.any(String) });
          expect((await rowsSince(host, staff, 'publishVersion', since)).map((r) => (r.after as { admission: string }).admission))
            .toEqual(['admitted']);
        });
      });

      // #2565: a promote reads the listing in the unit that moves prod, as listing reads prod.
      it('promoteVersion refuses an auto-admitted version as prod of a vertical listed since it was read', async () => {
        await withFixture(async (fixture, host, staff) => {
          const { slug, release } = await privateVertical(host, staff);
          const auto = await release();
          const since = new Date().toISOString();
          fixture.interleave(`UPDATE verticals SET listed = 1 WHERE slug = '${slug}'`);
          const refused = await refusalOf(host.admin.promoteVersion(staff, slug, 'prod', auto));
          expect(errorCodeOf(refused)).toBe('conflict');
          expect(refused.message).toContain(`prod version ${auto} is auto-admitted`);
          expect(await host.admin.listChannels(staff, slug)).toEqual([]);
          expect(await rowsSince(host, staff, 'promoteVersion', since)).toEqual([]);
        });
      });

      it('and, unlistedOnly, refuses any version of a vertical listed since it was read', async () => {
        await withFixture(async (fixture, host, staff) => {
          const { slug, release } = await privateVertical(host, staff);
          const vouched = await release();
          await host.admin.admitVersion(staff, vouched);
          const since = new Date().toISOString();
          fixture.interleave(`UPDATE verticals SET listed = 1 WHERE slug = '${slug}'`);
          const refused = await refusalOf(host.admin.promoteVersion(staff, slug, 'prod', vouched, undefined, { unlistedOnly: true }));
          expect(errorCodeOf(refused)).toBe('forbidden');
          expect(await host.admin.listChannels(staff, slug)).toEqual([]);
          expect(await rowsSince(host, staff, 'promoteVersion', since)).toEqual([]);
        });
      });

      it('re-promoting the auto-admitted version a listed vertical names as prod is refused only if its serve would change what runs', async () => {
        await withFixture(async (fixture, host, staff) => {
          const { slug, release } = await privateVertical(host, staff);
          const auto = await release();
          const vouched = await release();
          await host.admin.promoteVersion(staff, slug, 'prod', auto);
          // Listed before listing refused an auto-admitted prod: the state is kept, not judged again.
          await fixture.directorySql(`UPDATE verticals SET listed = 1 WHERE slug = '${slug}'`);
          await host.admin.promoteVersion(staff, slug, 'prod', auto);
          expect((await host.admin.listChannels(staff, slug)).find((c) => c.channel === 'prod')?.versionId).toBe(auto);
          // Serving the same version (the usual hosted state): the retry changes nothing either.
          await fixture.directorySql(`UPDATE verticals SET serving_ref = 'serving-a', serving_version_id = '${auto}' WHERE slug = '${slug}'`);
          await host.admin.promoteVersion(staff, slug, 'prod', auto);
          // A failed serve left another version serving: the retry would put `auto` on every install.
          await fixture.directorySql(`UPDATE verticals SET serving_ref = 'serving-a', serving_version_id = '${vouched}' WHERE slug = '${slug}'`);
          const refused = await refusalOf(host.admin.promoteVersion(staff, slug, 'prod', auto));
          expect(errorCodeOf(refused)).toBe('conflict');
          expect(refused.message).toContain(`prod version ${auto} is auto-admitted`);
        });
      });

      it('setVerticalServing refuses a serve whose serving version moved, and a retry after reading it again lands', async () => {
        await withFixture(async (fixture, host, staff) => {
          const slug = await newVertical(host, staff);
          const [first, second, third] = [await publish(host, staff, slug), await publish(host, staff, slug), await publish(host, staff, slug)];
          const serve = (versionId: string, ref: string) =>
            host.admin.setVerticalServing(staff, slug, { ref, versionId, doClasses: [], migrationTag: 'g' });
          const rows = async () => (await host.admin.auditLog(staff, { action: ['setVerticalServing'] }))
            .filter((r) => (r.after as { vertical: string }).vertical === slug)
            .map((r) => ({ before: r.before, after: r.after }));
          await serve(first, 'serving-a');
          fixture.interleave(`UPDATE verticals SET serving_ref = 'serving-b', serving_version_id = '${second}' WHERE slug = '${slug}'`);
          const lost = await refusalOf(serve(third, 'serving-c'));
          expect(errorCodeOf(lost)).toBe('precondition_failed');
          expect(lost.message).toContain('moved while this serve was being judged');
          expect((await host.admin.verticalServing(staff, slug))?.versionId).toBe(second);
          expect(await rows()).toHaveLength(1);
          await serve(third, 'serving-c');
          expect((await host.admin.verticalServing(staff, slug))?.versionId).toBe(third);
          expect(await rows()).toEqual([
            { before: null, after: { vertical: slug, ref: 'serving-a', versionId: first } },
            { before: { ref: 'serving-b', versionId: second }, after: { vertical: slug, ref: 'serving-c', versionId: third } },
          ]);
        });
      });

      it('setVerticalServing refuses a serve whose serving ref moved while its version stayed', async () => {
        await withFixture(async (fixture, host, staff) => {
          const slug = await newVertical(host, staff);
          const [first, second] = [await publish(host, staff, slug), await publish(host, staff, slug)];
          const serve = (versionId: string, ref: string) =>
            host.admin.setVerticalServing(staff, slug, { ref, versionId, doClasses: [], migrationTag: 'g' });
          await serve(first, 'serving-a');
          fixture.interleave(`UPDATE verticals SET serving_ref = 'serving-b' WHERE slug = '${slug}'`);
          const lost = await refusalOf(serve(second, 'serving-c'));
          expect(errorCodeOf(lost)).toBe('precondition_failed');
          expect(await host.admin.verticalServing(staff, slug)).toMatchObject({ ref: 'serving-b', versionId: first });
          // Only the first serve's row: the refused one recorded none.
          expect((await host.admin.auditLog(staff, { action: ['setVerticalServing'] }))
            .filter((r) => (r.after as { vertical: string }).vertical === slug)
            .map((r) => (r.after as { ref: string }).ref)).toEqual(['serving-a']);
        });
      });

      // #2577: a serve of v2 (adding a class) and a re-serve of v1 bring the ref and version back over
      // a grown class set and tag; a serve whose upload diffed its migration from the state before
      // them must not record over it. One that moved only the ref and version left that diff right.
      it('setVerticalServing refuses a serve computed from a class set and tag that moved, and records over a moved ref and version', async () => {
        await withFixture(async (fixture, host, staff) => {
          const slug = await newVertical(host, staff);
          const [first, second, third] = [await publish(host, staff, slug), await publish(host, staff, slug), await publish(host, staff, slug)];
          const ref = 'serving-a';
          const grow = (tag: string) =>
            `UPDATE verticals SET serving_do_classes = '["ScopeDO","Added"]', serving_migration_tag = '${tag}' WHERE slug = '${slug}'`;
          await host.admin.setVerticalServing(staff, slug, { ref, versionId: first, doClasses: ['ScopeDO'], migrationTag: 'v1' });
          const serveFrom = async (from: Awaited<ReturnType<typeof host.admin.verticalServing>>, versionId: string) =>
            host.admin.setVerticalServing(staff, slug, { ref, versionId, doClasses: from!.doClasses, migrationTag: from!.migrationTag }, from);
          // Another serve moved only the ref and version after the caller read the row: recorded over.
          const before = await host.admin.verticalServing(staff, slug);
          await fixture.directorySql(`UPDATE verticals SET serving_ref = 'serving-b', serving_version_id = '${second}' WHERE slug = '${slug}'`);
          await serveFrom(before, third);
          expect(await host.admin.verticalServing(staff, slug)).toEqual({ ref, versionId: third, doClasses: ['ScopeDO'], migrationTag: 'v1' });
          // The class set and tag moved after the caller read the row, and after the host read it.
          const stale = await host.admin.verticalServing(staff, slug);
          await fixture.directorySql(grow('v2'));
          expect(errorCodeOf(await refusalOf(serveFrom(stale, second)))).toBe('precondition_failed');
          fixture.interleave(grow('v3'));
          expect(errorCodeOf(await refusalOf(serveFrom(await host.admin.verticalServing(staff, slug), second)))).toBe('precondition_failed');
          expect(await host.admin.verticalServing(staff, slug))
            .toEqual({ ref, versionId: third, doClasses: ['ScopeDO', 'Added'], migrationTag: 'v3' });
          expect((await host.admin.auditLog(staff, { action: ['setVerticalServing'] }))
            .filter((r) => (r.after as { vertical: string }).vertical === slug)).toHaveLength(2);
        });
      });

      // #2526: the org and the connection a grant names are judged in the unit that writes it.
      it.each(['grantToOrg', 'addMember'] as const)('%s refuses an org deleted since it was read, and writes nothing', async (action) => {
        await withFixture(async (fixture, host, staff) => {
          const t = await newTenant(host, staff);
          const org = await newOrg(host, staff, t);
          const who = principalId.parse(ulid());
          const since = new Date().toISOString();
          fixture.interleave(`DELETE FROM orgs WHERE org_id = '${org}'`);
          const refused = await refusalOf(action === 'grantToOrg'
            ? host.admin.grantToOrg(staff, org, AUDIT_READ, { tenantId: t, scopeId: null })
            : host.admin.addMember(staff, t, who, org));
          expect(errorCodeOf(refused)).toBe('not_found');
          expect(refused.message).toBe(`unknown org ${org} in tenant ${t}`);
          expect(await fixture.directoryRows(`SELECT 1 FROM _substrat_tenant_tuples WHERE tenant_id = '${t}'`)).toEqual([]);
          expect(await rowsSince(host, staff, action, since)).toEqual([]);
        });
      });

      it('grantToConnection refuses a connection revoked since it was read, and writes nothing', async () => {
        await withFixture(async (fixture, host, staff) => {
          const t = await newTenant(host, staff);
          const conn = await newConnection(host, staff, t);
          const since = new Date().toISOString();
          fixture.interleave(`UPDATE _substrat_connections SET revoked_at = '${since}' WHERE id = '${conn.id}'`);
          const refused = await refusalOf(host.admin.grantToConnection(staff,
            { connectionId: conn.id, permission: AUDIT_READ, node: { tenantId: t, scopeId: null }, grantedBy: staff }));
          expect(refused.message).toContain(`connection ${conn.id} is revoked — grant nothing to it`);
          expect(await fixture.directoryRows(`SELECT 1 FROM _substrat_connection_grants WHERE connection_id = '${conn.id}'`)).toEqual([]);
          expect(await tenantTuples(fixture, t, `connection:${conn.id}`, `granted:${AUDIT_READ}`)).toBe(0);
          expect(await rowsSince(host, staff, 'grantToConnection', since)).toEqual([]);
        });
      });

      it('defineRole records the role its own unit read as its before', async () => {
        await withFixture(async (fixture, host, staff) => {
          const t = await newTenant(host, staff);
          await host.admin.defineRole(staff, t, { key: 'auditor', permissions: [AUDIT_READ], source: 'vertical' });
          fixture.interleave(`UPDATE _substrat_roles SET permissions = '["audit:write"]' WHERE tenant_id = '${t}' AND role_key = 'auditor'`);
          await host.admin.defineRole(staff, t, { key: 'auditor', permissions: [AUDIT_READ], source: 'vertical' });
          // The first definition's row has no `before`; the second's is the role as the interleave left it.
          const befores = (await host.admin.auditLog(staff, { tenantId: t, action: ['defineRole'] }))
            .map((r) => (r.before as { permissions: string[] } | null)?.permissions ?? null);
          expect(befores).toHaveLength(2);
          expect(befores).toEqual(expect.arrayContaining([null, ['audit:write']]));
        });
      });

      it('setTenantStatus records the status its own unit read', async () => {
        await withFixture(async (fixture, host, staff) => {
          const t = await newTenant(host, staff);
          fixture.interleave(`UPDATE tenants SET status = 'suspended' WHERE tenant_id = '${t}'`);
          await host.admin.setTenantStatus(staff, t, 'active');
          expect((await host.admin.auditLog(staff, { tenantId: t, action: ['setTenantStatus'] })).map((r) => [r.before, r.after]))
            .toEqual([[{ status: 'suspended' }, { status: 'active' }]]);
        });
      });

      it('setTenantName records the name its own unit read, and nothing when that is already the name', async () => {
        await withFixture(async (fixture, host, staff) => {
          const t = await newTenant(host, staff, 'Before');
          fixture.interleave(`UPDATE tenants SET name = 'Middle' WHERE tenant_id = '${t}'`);
          await host.admin.setTenantName(staff, t, 'After');
          fixture.interleave(`UPDATE tenants SET name = 'Last' WHERE tenant_id = '${t}'`);
          await host.admin.setTenantName(staff, t, 'Last');
          expect((await host.admin.getTenant(staff, t))?.name).toBe('Last');
          expect((await host.admin.auditLog(staff, { tenantId: t, action: ['setTenantName'] })).map((r) => [r.before, r.after]))
            .toEqual([[{ name: 'Middle' }, { name: 'After' }]]);
        });
      });

      // #2526: the hostname and entitlement writes judge their guard, their no-op and their row's
      // `before` in the unit that writes. A no-op writes nothing and records nothing; each is
      // paired with the change beside it that does record.
      /** A hostname row as another caller would write it, for an interleave. */
      const hostnameInsert = (hostname: string, t: TenantId, s: ScopeId) =>
        `INSERT INTO hostnames (hostname, tenant_id, scope_id, vertical_slug, surface, region, status, status_note, canonical,
           created_at, custom_hostname_id, validation_records)
         VALUES ('${hostname}', '${t}', '${s}', NULL, 'app', NULL, 'pending', NULL, 0, '2026-10-25T00:00:00.000Z', NULL, NULL)`;

      it('bindHostname refuses a name another live scope bound since it was read, demoting nothing', async () => {
        await withFixture(async (fixture, host, staff) => {
          const t = await newTenant(host, staff);
          const [mine, theirs] = [await newScope(host, staff, t), await newScope(host, staff, t)];
          const canonical = await bound(host, t, mine, true);
          const hostname = hostnameOf();
          const since = new Date().toISOString();
          fixture.interleave(hostnameInsert(hostname, t, theirs));
          const refused = await refusalOf(host.admin.bindHostname(staff,
            { hostname, tenantId: t, scopeId: mine, surface: 'app', region: null, canonical: true }));
          expect(errorCodeOf(refused)).toBe('conflict');
          expect(refused.message).toBe(`hostname '${hostname}' is already bound to another scope`);
          expect(await scopeHostnames(host, staff, mine)).toEqual([[canonical, true]]);
          expect(await scopeHostnames(host, staff, theirs)).toEqual([[hostname, false]]);
          expect(await rowsSince(host, staff, 'bindHostname', since)).toEqual([]);
        });
      });

      it('and reclaims a name whose holder was archived since it was read', async () => {
        await withFixture(async (fixture, host, staff) => {
          const t = await newTenant(host, staff);
          const [mine, theirs] = [await newScope(host, staff, t), await newScope(host, staff, t)];
          const hostname = await bound(host, t, theirs);
          const since = new Date().toISOString();
          fixture.interleave(`UPDATE scopes SET status = 'archived' WHERE scope_id = '${theirs}'`);
          await host.admin.bindHostname(staff, { hostname, tenantId: t, scopeId: mine, surface: 'app', region: null, canonical: false });
          expect(await scopeHostnames(host, staff, mine)).toEqual([[hostname, false]]);
          expect((await rowsSince(host, staff, 'bindHostname', since)).map((r) => (r.after as { scopeId: string }).scopeId)).toEqual([mine]);
        });
      });

      it('setHostnameStatus records nothing for a status set since it was read, and the status its unit read otherwise', async () => {
        await withFixture(async (fixture, host, staff) => {
          const t = await newTenant(host, staff);
          const s = await newScope(host, staff, t);
          const hostname = await bound(host, t, s);
          const since = new Date().toISOString();
          fixture.interleave(`UPDATE hostnames SET status = 'active' WHERE hostname = '${hostname}'`);
          await host.admin.setHostnameStatus(staff, hostname, 'active');
          expect(await rowsSince(host, staff, 'setHostnameStatus', since)).toEqual([]);
          fixture.interleave(`UPDATE hostnames SET status = 'failed' WHERE hostname = '${hostname}'`);
          await host.admin.setHostnameStatus(staff, hostname, 'active');
          expect(await hostnameStatus(host, staff, s, hostname)).toBe('active');
          expect(await rowsSince(host, staff, 'setHostnameStatus', since))
            .toEqual([{ before: { status: 'failed' }, after: { status: 'active', note: null } }]);
        });
      });

      it('setHostnameIssuance records nothing for a poll that finds what another write already stored, and one row for a poll that changes it', async () => {
        await withFixture(async (fixture, host, staff) => {
          const t = await newTenant(host, staff);
          const s = await newScope(host, staff, t);
          const hostname = await bound(host, t, s);
          const poll = { status: 'verifying' as const, customHostnameId: 'cf-audit', validationRecords: RECORDS };
          const since = new Date().toISOString();
          fixture.interleave(`UPDATE hostnames SET status = 'verifying', custom_hostname_id = 'cf-audit',
            validation_records = '${JSON.stringify(RECORDS)}' WHERE hostname = '${hostname}'`);
          await host.admin.setHostnameIssuance(staff, hostname, poll);
          expect(await rowsSince(host, staff, 'setHostnameIssuance', since)).toEqual([]);
          // Its twin: a poll that resolves it records one row, `before` the status the unit read.
          await host.admin.setHostnameIssuance(staff, hostname, { status: 'active', validationRecords: [] });
          expect(await hostnameStatus(host, staff, s, hostname)).toBe('active');
          expect(await rowsSince(host, staff, 'setHostnameIssuance', since))
            .toEqual([{ before: { status: 'verifying' }, after: { status: 'active', note: null } }]);
        });
      });

      it('grantEntitlement records nothing for a grant another write already made, and the grant its unit read as before otherwise', async () => {
        await withFixture(async (fixture, host, staff) => {
          const t = await newTenant(host, staff);
          const held = (plan: string) => `INSERT OR REPLACE INTO _substrat_entitlements
            (tenant_id, entitlement_key, expires_at, quota, plan, granted_at, granted_by)
            VALUES ('${t}', 'audit-entitlement', NULL, NULL, '${plan}', '2026-10-25T00:00:00.000Z', 'interleaved')`;
          const since = new Date().toISOString();
          fixture.interleave(held('pro'));
          await host.admin.grantEntitlement(staff, t, 'audit-entitlement', { plan: 'pro' });
          expect(await rowsSince(host, staff, 'grantEntitlement', since)).toEqual([]);
          fixture.interleave(held('trial'));
          await host.admin.grantEntitlement(staff, t, 'audit-entitlement', { plan: 'pro' });
          expect(await entitlementsOf(host, staff, t)).toEqual([['audit-entitlement', 'pro']]);
          expect(await rowsSince(host, staff, 'grantEntitlement', since)).toEqual([{
            before: { entitlementKey: 'audit-entitlement', expiresAt: null, quota: null, plan: 'trial' },
            after: { entitlementKey: 'audit-entitlement', expiresAt: null, quota: null, plan: 'pro' },
          }]);
        });
      });

      it('revokeEntitlement records nothing for a grant revoked since it was read', async () => {
        await withFixture(async (fixture, host, staff) => {
          const t = await newTenant(host, staff);
          await host.admin.grantEntitlement(staff, t, 'audit-entitlement', { plan: 'pro' });
          const since = new Date().toISOString();
          fixture.interleave(`DELETE FROM _substrat_entitlements WHERE tenant_id = '${t}' AND entitlement_key = 'audit-entitlement'`);
          await host.admin.revokeEntitlement(staff, t, 'audit-entitlement');
          expect(await rowsSince(host, staff, 'revokeEntitlement', since)).toEqual([]);
        });
      });
    });
  });
}
