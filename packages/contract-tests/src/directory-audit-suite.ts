import { describe, it, expect } from 'vitest';
import { platformActorId, scopeId, tenantId, type AdminAction, type PlatformActorId, type TenantId } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { heldMigrations } from './held-migrations.js';

/**
 * #2479: what a directory audit suite needs of an adapter — its host, and one statement run
 * against the directory its admin log lives in, so a fault is a trigger in the real store.
 */
export interface DirectoryAuditFixture {
  host: ScopeHost;
  directorySql(sql: string): Promise<void>;
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
  arrange(host: ScopeHost, staff: PlatformActorId): Promise<{
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
      const slug = slugOf();
      const deploymentRef = `${slug}-serving`;
      const record = {
        envelope: 1 as const, entrySkipped: null, state: 'dual' as const, audience: deploymentRef,
        routerKids: ['If4x36FUomE'], platformKids: ['OfcT0KZEJT8'], withheld: null,
      };
      return {
        call: () => host.admin.recordWireAuth!(staff, { deploymentRef, verticalSlug: slug, versionId: 'v1', record, recordedAt: '2026-10-24T10:00:00.000Z' }),
        state: async () => (await host.admin.listWireAuth!(staff, { verticalSlug: slug }))[0]?.record ?? null,
        changed: record,
        row: { before: null, after: { vertical: slug, deploymentRef, versionId: 'v1', record } },
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
        const { call, state, changed, row } = await c.arrange(host, staff);
        const since = new Date().toISOString();
        const rows = () => host.admin.auditLog(staff, { action: [c.action], since });
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
  });
}
