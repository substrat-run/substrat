/**
 * Contract suite for a module's own indexes and triggers across a restore (#2820). A restore drops
 * every module table and replays it from the dump; the migrations that made the table's indexes and
 * triggers are journaled, so they never run again. The dump carries them, and a restore puts back
 * the ones that hold invariants: here a partial unique index and an append-only trigger, judged by
 * what they refuse afterwards. A trigger that writes is left out, and the restore's admin row names
 * it. The fixture is `moduleObjectsMod`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId, type ScopeDump } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { moduleObjectsMod } from './module-objects.js';

export function moduleObjectsContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  describe(`a module's own indexes and triggers across a restore (#2820): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const anyone = principalId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(moduleObjectsMod);
      await host.admin.createTenant(staff, { id: t, slug: `mo-${t.toLowerCase()}`, name: 'Module objects' });
      await host.admin.grantEntitlement(staff, t, 'module-objects');
    });
    afterAll(async () => {
      await fixture.cleanup();
    });

    /** A scope holding one lead, restored in place from its own dump as `edit` leaves it. */
    const restored = async (edit: (dump: ScopeDump) => ScopeDump = (d) => d) => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'module-objects' });
      await host.admin.activateScope(staff, t, s);
      const stub = await host.getScope(anyone, t, s);
      await stub.invoke('mo/insert', { id: 'a', who: 'x', lead: 1 });
      await host.restoreScope(staff, t, s, edit(await host.admin.exportScope(staff, t, s)));
      const [entry] = (await host.admin.auditLog(staff, { scopeId: s })).filter((r) => r.action === 'restoreScope');
      return { stub, moduleObjects: (entry?.after as { moduleObjects?: unknown }).moduleObjects };
    };

    it('puts back the partial unique index and the append-only trigger, and names the trigger it left out', async () => {
      const { stub, moduleObjects } = await restored();
      await expect(stub.invoke('mo/insert', { id: 'b', who: 'x', lead: 1 })).rejects.toThrow(/UNIQUE constraint failed/);
      await expect(stub.invoke('mo/demote', { id: 'a' })).rejects.toThrow(/append-only/);
      // The counting trigger did not come back: an insert the index admits leaves the count alone.
      await stub.invoke('mo/insert', { id: 'c', who: 'x', lead: 0 });
      expect(await stub.invoke('mo/count', undefined)).toBe(1);
      expect(moduleObjects).toEqual({ carried: 3, skipped: ['mo_count'] });
    });

    it('restores a dump written before objects were carried as before, and says they were not carried', async () => {
      const { stub, moduleObjects } = await restored((dump) => ({
        ...dump,
        tables: dump.tables.map(({ objects: _, ...table }) => table),
      }));
      await stub.invoke('mo/insert', { id: 'b', who: 'x', lead: 1 });
      expect(moduleObjects).toEqual({ carried: 'not carried', skipped: [] });
    });
  });
}
