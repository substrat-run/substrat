import { describe, expect, it } from 'vitest';
import { moduleId, orgId, permissionKey, platformActorId, principalId, scopeId, tenantId, type AdminAction } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { adminRowFaultSql } from './switch-audit-fault.js';

type Fixture = {
  host: ScopeHost;
  directoryExec(sql: string): Promise<void>;
  scopeExec(tenant: string, scope: string, sql: string): Promise<void>;
  scopeCount(tenant: string, scope: string, sql: string): Promise<number>;
  cleanup(): Promise<void>;
};

/** The same three real-store fault windows for each first-slice scope permission family. */
export function scopePermissionAuditSuite(adapter: string, makeFixture: () => Promise<Fixture>): void {
  describe(`scope permission audit: ${adapter}`, () => {
    it.each(['assignRole', 'unassignRole', 'grant', 'grantToOrg', 'grantToSystem', 'grantEntityShape', 'mintCapability'] as const)(
      '%s leaves an intent before mutation and preserves it through either later fault', async (action) => {
        const fixture = await makeFixture();
        const { host } = fixture;
        const staff = platformActorId.parse(ulid());
        const tenant = tenantId.parse(ulid());
        const scope = scopeId.parse(ulid());
        const principal = principalId.parse(ulid());
        const org = orgId.parse(ulid());
        const permission = permissionKey.parse('perm:audit');
        const roleKey = `audit-${ulid().toLowerCase()}`;
        const node = { tenantId: tenant, scopeId: scope };
        const target = { principalId: principal, roleKey, node };
        const entity = { entityType: 'item', entityId: `audit-${ulid().toLowerCase()}` };
        const relation = action === 'assignRole' || action === 'unassignRole' ? `role:${roleKey}` : `granted:${permission}`;
        const subject = action === 'grantToOrg' ? `org:${org}` : action === 'grantToSystem' ? `system:${moduleId.parse('@substrat-run/engine-workorder')}` : `principal:${principal}`;
        const stateSql = action === 'mintCapability'
          ? `SELECT COUNT(*) AS n FROM _substrat_capabilities WHERE principal = '${principal}'`
          : `SELECT COUNT(*) AS n FROM _substrat_tuples WHERE subject = '${subject}' AND relation = '${relation}' AND revoked_at IS NULL`;
        const call = (): Promise<unknown> => {
          switch (action) {
            case 'assignRole': return host.admin.assignRole(staff, target);
            case 'unassignRole': return host.admin.unassignRole(staff, target);
            case 'grant': return host.admin.grant(staff, { principalId: principal, permission, node, grantedBy: principal });
            case 'grantToOrg': return host.admin.grantToOrg(staff, org, permission, node);
            case 'grantToSystem': return host.admin.grantToSystem(staff, { moduleId: moduleId.parse('@substrat-run/engine-workorder'), permission, node, grantedBy: staff });
            case 'grantEntityShape': return host.admin.grantEntityShape(staff, { principalId: principal, node, entity, permissions: [permission], grantedBy: principal });
            case 'mintCapability': return host.admin.mintCapability(staff, tenant, scope, { principal, expiresAt: new Date(Date.now() + 60_000).toISOString() as never, maxUses: 1 });
          }
        };
        const rows = () => host.admin.auditLog(staff, { tenantId: tenant, scopeId: scope, action: action as AdminAction });
        const count = () => fixture.scopeCount(tenant, scope, stateSql);
        const fault = async (phase: 'intent' | 'applied') => {
          const { create, drop } = adminRowFaultSql(scope, phase);
          await fixture.directoryExec(create);
          return () => fixture.directoryExec(drop);
        };
        let lift: (() => Promise<void>) | undefined;
        try {
          await host.admin.createTenant(staff, { id: tenant, slug: `audit-${tenant.toLowerCase()}`, name: 'Audit' });
          await host.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'audit' });
          await host.admin.activateScope(staff, tenant, scope);
          if (action === 'assignRole' || action === 'unassignRole') await host.admin.defineRole(staff, tenant, { key: roleKey, permissions: [permission], source: 'vertical' });
          if (action === 'grantToOrg') await host.admin.createOrg(staff, { id: org, tenantId: tenant, slug: `audit-${org.toLowerCase()}`, name: 'Audit' });
          if (action === 'unassignRole') await host.admin.assignRole(staff, target);
          const before = await count();

          lift = await fault('intent');
          await expect(call()).rejects.toThrow();
          expect(await count()).toBe(before);
          expect(await rows()).toEqual([]);
          await lift(); lift = undefined;

          const table = action === 'mintCapability' ? '_substrat_capabilities' : '_substrat_tuples';
          const verb = action === 'unassignRole' ? 'UPDATE' : 'INSERT';
          const scopeTrigger = `test_scope_permission_fault`;
          await fixture.scopeExec(tenant, scope, `CREATE TRIGGER ${scopeTrigger} BEFORE ${verb} ON ${table} BEGIN SELECT RAISE(ABORT, 'scope write refused (test fault)'); END`);
          try {
            await expect(call()).rejects.toThrow();
          } finally {
            await fixture.scopeExec(tenant, scope, `DROP TRIGGER IF EXISTS ${scopeTrigger}`);
          }
          expect(await count()).toBe(before);
          const failed = await rows();
          expect(failed.map((r) => (r.after as { phase: string }).phase)).toEqual(['intent']);
          expect(await host.admin.settleUnrecordedOutcome(staff, { intentId: failed[0]!.id, error: 'scope answer unknown' })).toBe(true);

          lift = await fault('applied');
          const result = await call();
          await lift(); lift = undefined;
          expect(await count()).toBe(action === 'unassignRole' ? 0 : before + 1);
          const pending = (await rows()).filter((r) => (r.after as { phase: string }).phase === 'intent');
          expect(pending).toHaveLength(2);
          const latest = pending.at(-1)!;
          const operationId = (latest.after as { operationId: string }).operationId;
          expect(await host.admin.settleUnrecordedOutcome(staff, { intentId: latest.id, error: 'outcome missing' })).toBe(true);
          expect((await rows()).filter((r) => (r.after as { operationId?: string }).operationId === operationId)
            .map((r) => (r.after as { phase: string }).phase)).toEqual(['intent', 'unknown']);
          if (action === 'mintCapability') {
            const text = JSON.stringify(await rows());
            expect(text).not.toContain((result as { secret: string }).secret);
          }
          await call();
          const confirmed = (await rows()).slice(-2);
          expect(confirmed.map((r) => (r.after as { phase: string }).phase))
            .toEqual(['intent', action === 'unassignRole' ? 'refused' : 'applied']);
          expect((confirmed[0]!.after as { operationId: string }).operationId)
            .toBe((confirmed[1]!.after as { operationId: string }).operationId);
          if (action === 'unassignRole') expect((confirmed[1]!.after as { changed: boolean }).changed).toBe(false);
        } finally {
          if (lift) await lift();
          await fixture.cleanup();
        }
      },
    );
  });
}
