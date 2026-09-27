/**
 * Contract suite for the per-request record's scope half (#1746): `ScopeStub.subjectKind`
 * and `InvokeOptions.onEmitted`.
 *
 * What it pins is the invocation log line's honesty about what a request touched. The line
 * names the entities and event types an operation emitted, so a reader can facet requests
 * by entity without joining the spine. That is only worth having if the list is the
 * operation's OWN work: not its consumers' follow-on events, not a rolled-back
 * sub-transaction's, not a failed call's, and not a replay's. Each case below is one of
 * those, driven against a real scope on both adapters, because the DO answers across an
 * RPC hop and the SQLite host does not, and the difference is exactly where a report gets
 * lost or double-counted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { EMITTED_REPORT_CAP, ulid, type EmittedReport, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { emittedMod } from './modules.js';

export function emittedReportContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`invocation emitted report (#1746): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    let stub: ScopeStub;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const alice = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    /** Every report the host delivered for one call — so "never called" is `[]`. */
    const run = async (operation: string, input?: unknown, extra: object = {}) => {
      const reports: EmittedReport[] = [];
      let error: unknown;
      try {
        await stub.invoke(operation, input, { ...extra, onEmitted: (r) => reports.push(r) });
      } catch (e) {
        error = e;
      }
      return { reports, error };
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(emittedMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'emitted-tenant', name: 'Emitted Tenant' });
      await host.admin.grantEntitlement(staff, t1, 'emitted');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'emitted-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      stub = await host.getScope(alice, t1, s1);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('says which kind of subject a principal stub acts as', () => {
      expect(stub.subjectKind).toBe('principal');
    });

    it("reports the operation's own events, in order, and none of its consumers'", async () => {
      const a = `a-${ulid()}`;
      const b = `b-${ulid()}`;
      const { reports, error } = await run('emitted/touch', { ids: [a, b] });
      expect(error).toBeUndefined();
      // Two `emitted.echoed` rows were committed in the same invocation by the consumer.
      // They are the consumer's work, and naming them would say this request touched
      // entities its handler never saw.
      expect(reports).toEqual([
        {
          events: [
            { type: 'emitted.touched', entity: `emitted-thing:${a}` },
            { type: 'emitted.touched', entity: `emitted-thing:${b}` },
          ],
          total: 2,
        },
      ]);
    });

    it('reports an empty list for an operation that emitted nothing', async () => {
      // A fact, not an absence: a read touched nothing, and that is worth saying.
      expect((await run('emitted/read')).reports).toEqual([{ events: [], total: 0 }]);
    });

    it('never reports for a call that rolled back', async () => {
      const { reports, error } = await run('emitted/fail', { ids: [`f-${ulid()}`] });
      expect(error).toBeDefined();
      expect(reports).toEqual([]);
    });

    it("leaves out a rolled-back sub-transaction's emit", async () => {
      const kept = `k-${ulid()}`;
      const { reports } = await run('emitted/partial', { kept, dropped: `d-${ulid()}` });
      expect(reports).toEqual([{ events: [{ type: 'emitted.touched', entity: `emitted-thing:${kept}` }], total: 1 }]);
    });

    it('caps the list and keeps the uncapped count', async () => {
      const ids = Array.from({ length: EMITTED_REPORT_CAP + 5 }, (_, i) => `c${i}-${ulid()}`);
      const { reports } = await run('emitted/touch', { ids });
      expect(reports).toHaveLength(1);
      expect(reports[0]!.total).toBe(EMITTED_REPORT_CAP + 5);
      expect(reports[0]!.events.map((e) => e.entity)).toEqual(
        ids.slice(0, EMITTED_REPORT_CAP).map((id) => `emitted-thing:${id}`),
      );
    });

    it('does not report a replay, which committed nothing', async () => {
      const idempotencyKey = `key-${ulid()}`;
      const input = { ids: [`r-${ulid()}`] };
      expect((await run('emitted/touch', input, { idempotencyKey })).reports).toHaveLength(1);
      expect((await run('emitted/touch', input, { idempotencyKey })).reports).toEqual([]);
    });
  });
}
