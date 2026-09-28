import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { moduleId, platformActorId, scopeId, tenantId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { scheduleMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

const SCHED = moduleId.parse('@test/sched');

/**
 * #1742 review, on the pure host: a restore re-asserts the directory's recorded-off switch
 * INSIDE the replay's transaction, so a switch that throws part-way rolls the whole restore
 * back rather than commit the dump's live grants with no switch over them.
 *
 * The shared suite used to prove this with a dump whose `_substrat_tuples` DDL carried a CHECK
 * refusing the OFF marker. Since #1883 that table is built from KERNEL_DDL, so no dump can make
 * the switch throw, and the fault is injected at the switch's own write instead: the scope's
 * connection refuses to run the statement that writes the marker. The DO has the same test
 * (`adapter-cloudflare/test/contract.test.ts`).
 */
describe('#1742: a switch that fails inside a restore rolls the whole restore back', () => {
  const setup = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-restore-switch-'));
    const host = new SqliteScopeHost({ dir });
    host.registerModule(scheduleMod);
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `rollback-${t.slice(-10).toLowerCase()}`, name: 'Rollback' });
    await host.admin.grantEntitlement(staff, t, 'sched');
    await host.provisionScope(staff, { tenantId: t, scopeId: s });
    await host.admin.activateScope(staff, t, s);
    const dump = await host.admin.exportScope(staff, t, s);
    await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'incident' });
    const done = async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { host, staff, t, s, dump, done };
  };

  /** The scope's connection, made to refuse any statement that writes the OFF marker. */
  const refuseMarker = (host: SqliteScopeHost, t: TenantId, s: ScopeId) => {
    const db = (host as unknown as { runtime(t: TenantId, s: ScopeId): { db: Database.Database } }).runtime(t, s).db;
    const prepare = db.prepare.bind(db);
    db.prepare = ((source: string) => {
      const stmt = prepare(source);
      const run = stmt.run.bind(stmt);
      stmt.run = ((...params: unknown[]) => {
        if (params.includes('switch:off')) throw new Error('the OFF marker was refused (test fault)');
        return run(...params);
      }) as typeof stmt.run;
      return stmt;
    }) as typeof db.prepare;
  };

  it('the dump lands nowhere: the scope stays off, and nothing is audited as a re-assert', async () => {
    const { host, staff, t, s, dump, done } = await setup();
    try {
      refuseMarker(host, t, s);
      await expect(host.restoreScope(staff, t, s, dump)).rejects.toThrow(/the OFF marker was refused \(test fault\)/);
      const status = await host.admin.systemGrantsStatus(staff, { tenantId: t, scopeId: s });
      expect(status.map((e) => [e.schedules, e.recorded])).toEqual([['off', 'off']]);
      expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: 0, switchedOff: true });
      expect(await host.admin.auditLog(staff, { tenantId: t, scopeId: s, action: ['reassertSystemSwitch'] })).toEqual([]);
    } finally {
      await done();
    }
  });

  it('twin: without the fault, the same restore lands and the module is switched off by it', async () => {
    const { host, staff, t, s, dump, done } = await setup();
    try {
      await host.restoreScope(staff, t, s, dump);
      const status = await host.admin.systemGrantsStatus(staff, { tenantId: t, scopeId: s });
      expect(status.map((e) => [e.schedules, e.recorded])).toEqual([['off', 'off']]);
      expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: 0, switchedOff: true });
      expect(await host.admin.auditLog(staff, { tenantId: t, scopeId: s, action: ['reassertSystemSwitch'] })).toHaveLength(1);
    } finally {
      await done();
    }
  });
});
