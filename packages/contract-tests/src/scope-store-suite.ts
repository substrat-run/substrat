import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { errorCodeOf, platformActorId, principalId, scopeId, storeEraseInput, tenantId, type ScopeId } from '@substrat-run/contracts';
import { ulid, type ScopeHost, type ScopeStoreRunner, type StoreCallReport } from '@substrat-run/kernel';
import { STORE_CALL_SINK_KEY, tallyStoreCall, type StoreCallTally } from '@substrat-run/kernel/invocation-line';
import { counterScopeStoreRunner, invalidStoreInput, objectNameOf } from './counter-runner.js';
import type { ScopeHostFixture } from './scope-host-suite.js';

/**
 * The trivial kind, with what this suite reads back about the host's calls:
 * `address` (what the host handed in), `erased` (the subjects erased on this object),
 * `wiped` (every object wiped), and `fail-wipe` (`true` makes each later `substrat.wipe`
 * answer 503, until `false`).
 */
function instrumentedCounterRunner(): ScopeStoreRunner {
  const counter = counterScopeStoreRunner();
  const erased = new Map<string, Set<string>>();
  const wiped = new Set<string>();
  let failWipe = false;
  return {
    ...counter,
    async invoke(address, request) {
      const id = objectNameOf(address);
      switch (request.operation) {
        case 'address': {
          const { tenantId, vertical, scopeId, binding } = address;
          return { result: { tenantId, vertical, scopeId, binding } };
        }
        case 'erased':
          return { result: [...(erased.get(id) ?? [])] };
        case 'wiped':
          return { result: [...wiped] };
        case 'fail-wipe':
          if (typeof request.input !== 'boolean') return invalidStoreInput('fail-wipe takes a boolean');
          failWipe = request.input;
          return { result: failWipe };
        case 'substrat.wipe':
          if (failWipe) return { error: { code: 'unavailable', status: 503 } };
          wiped.add(id);
          return counter.invoke(address, request);
        case 'substrat.erase': {
          const answer = await counter.invoke(address, request);
          if ('result' in answer) {
            const { subjectId } = storeEraseInput.parse(request.input);
            erased.set(id, (erased.get(id) ?? new Set<string>()).add(subjectId));
          }
          return answer;
        }
        default:
          return counter.invoke(address, request);
      }
    },
  };
}

/**
 * Scope stores on every adapter (#2213). The fixture is handed the runner, so
 * both hosts answer the same counter. The reserved name is refused by the stub.
 */
export function scopeStoreContractSuite(
  adapterName: string,
  makeFixture: (
    scopeStores: { runners: { binding: string; runner: ScopeStoreRunner }[] },
  ) => Promise<ScopeHostFixture>,
): void {
  describe(`scope stores (#2213): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const staff = platformActorId.parse(ulid());
    const principal = principalId.parse(ulid());
    const tenant = tenantId.parse(ulid());
    const scopeA = scopeId.parse(ulid());
    const scopeB = scopeId.parse(ulid());
    const otherVertical = scopeId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture({ runners: [{ binding: 'GRAPH', runner: instrumentedCounterRunner() }] });
      host = fixture.host;
      await host.admin.createTenant(staff, { id: tenant, slug: `t-${tenant.toLowerCase()}`, name: 'T' });
      await host.provisionScope(staff, { tenantId: tenant, scopeId: scopeA, vertical: 'docs' });
      await host.provisionScope(staff, { tenantId: tenant, scopeId: scopeB, vertical: 'docs' });
      await host.provisionScope(staff, { tenantId: tenant, scopeId: otherVertical, vertical: 'other' });
      await host.admin.activateScope(staff, tenant, scopeA);
      await host.admin.activateScope(staff, tenant, scopeB);
      await host.admin.activateScope(staff, tenant, otherVertical);
    });
    afterAll(async () => {
      await fixture?.cleanup();
    });

    /** A valid table no scope has: present after a restore only if the dump's tables loaded. */
    const PROBE_TABLE = { name: 'restore_probe', ddl: 'CREATE TABLE restore_probe (id TEXT)', columns: ['id'], rows: [['x']] };
    const tableNames = async (scope: typeof scopeA) =>
      (await host.admin.exportScope(staff, tenant, scope)).tables.map((table) => table.name);

    it('the runner is handed the tenant, the vertical, the scope and the binding', async () => {
      const store = await host.getScopeStore(principal, tenant, scopeA, 'GRAPH');
      expect(await store.invoke('address')).toEqual({
        tenantId: tenant,
        vertical: 'docs',
        scopeId: scopeA,
        binding: 'GRAPH',
      });
    });

    it('one runner starts once when the first calls overlap', async () => {
      let started = 0;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const slow: ScopeStoreRunner = {
        kind: 'slow',
        async start() {
          started += 1;
          await gate;
        },
        async stop() {},
        async invoke() {
          return { result: started };
        },
      };
      const extra = await makeFixture({
        runners: [
          { binding: 'A', runner: slow },
          { binding: 'B', runner: slow },
        ],
      });
      try {
        const t = tenantId.parse(ulid());
        const scope = scopeId.parse(ulid());
        await extra.host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
        await extra.host.provisionScope(staff, { tenantId: t, scopeId: scope, vertical: 'docs' });
        await extra.host.admin.activateScope(staff, t, scope);
        const pending = Promise.all([
          extra.host.getScopeStore(principal, t, scope, 'A'),
          extra.host.getScopeStore(principal, t, scope, 'B'),
          extra.host.getScopeStore(principal, t, scope, 'A'),
        ]);
        const deadline = Date.now() + 2000;
        while (started === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(started).toBe(1);
        release();
        await pending;
        expect(started).toBe(1);
      } finally {
        await extra.cleanup();
      }
    });

    it('a declared binding reaches its object', async () => {
      const store = await host.getScopeStore(principal, tenant, scopeA, 'GRAPH');
      expect(await store.invoke('increment', { by: 1 })).toBe(1);
      expect(await store.invoke('read')).toBe(1);
    });

    it('an undeclared binding is refused', async () => {
      const refusal = await host.getScopeStore(principal, tenant, scopeA, 'OTHER').then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(errorCodeOf(refusal)).toBe('not_found');
    });

    it('two scopes never share an object', async () => {
      const store = await host.getScopeStore(principal, tenant, scopeB, 'GRAPH');
      expect(await store.invoke('read')).toBe(0);
    });

    it('two verticals never share an object', async () => {
      const store = await host.getScopeStore(principal, tenant, otherVertical, 'GRAPH');
      expect(await store.invoke('read')).toBe(0);
      expect(await store.invoke('increment', { by: 5 })).toBe(5);
      const docs = await host.getScopeStore(principal, tenant, scopeA, 'GRAPH');
      expect(await docs.invoke('read')).toBe(1);
    });

    it('an administrator reads the size of each declared store', async () => {
      const store = await host.getScopeStore(principal, tenant, scopeA, 'GRAPH');
      const current = await store.invoke('read');
      expect(await host.admin.scopeStoreSizes(staff, tenant, scopeA)).toEqual([
        { binding: 'GRAPH', bytes: current },
      ]);
      const reads = await host.admin.accessLog(staff, { tenantId: tenant, method: 'scopeStoreSizes' });
      expect(reads.some((entry) => entry.scopeId === scopeA)).toBe(true);
    });

    it('an unknown scope is refused before a store is asked', async () => {
      const refusal = await host.admin.scopeStoreSizes(staff, tenant, scopeId.parse(ulid())).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(errorCodeOf(refusal)).toBe('not_found');
    });

    it('an erasure reaches the store, and a second one counts zero', async () => {
      const subject = ulid();
      const first = await host.admin.shredSubject(staff, tenant, scopeA, subject);
      expect(first.storeErasures).toEqual([{ binding: 'GRAPH', erased: 1 }]);
      const store = await host.getScopeStore(principal, tenant, scopeA, 'GRAPH');
      expect(await store.invoke('erased')).toEqual([subject]);
      const again = await host.admin.shredSubject(staff, tenant, scopeA, subject);
      expect(again.storeErasures).toEqual([{ binding: 'GRAPH', erased: 0 }]);
    });

    it('a snapshot carries the store, and the fork then diverges', async () => {
      const original = await host.getScopeStore(principal, tenant, scopeA, 'GRAPH');
      const before = await original.invoke('read');
      const fork = await host.snapshotScope(staff, tenant, scopeA);
      const forked = await host.getScopeStore(principal, tenant, fork, 'GRAPH');
      expect(await forked.invoke('read')).toBe(before);
      await original.invoke('increment', { by: 1 });
      expect(await forked.invoke('read')).toBe(before);
      expect(await original.invoke('read')).toBe(Number(before) + 1);
    });

    it('a restore replaces the store', async () => {
      const store = await host.getScopeStore(principal, tenant, scopeB, 'GRAPH');
      await store.invoke('increment', { by: 4 });
      const dump = await host.admin.exportScope(staff, tenant, scopeB);
      expect(dump.stores).toEqual([
        expect.objectContaining({ binding: 'GRAPH', kind: 'counter' }),
      ]);
      await store.invoke('increment', { by: 1 });
      await host.restoreScope(staff, tenant, scopeB, dump);
      expect(await store.invoke('read')).toBe(4);
    });

    it('a restore that names an unbound store writes nothing', async () => {
      const store = await host.getScopeStore(principal, tenant, scopeB, 'GRAPH');
      // scopeB carries the counter the tests above left behind.
      const before = Number(await store.invoke('read'));
      await store.invoke('increment', { by: 3 });
      const dump = await host.admin.exportScope(staff, tenant, scopeB);
      await store.invoke('increment', { by: 1 });
      const refusal = await host.restoreScope(staff, tenant, scopeB, {
        ...dump,
        tables: [...dump.tables, PROBE_TABLE],
        stores: [...dump.stores, { binding: 'MISSING', kind: 'counter', tables: [] }],
      }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(errorCodeOf(refusal)).toBe('not_found');
      // Neither the restore of the dump's GRAPH (before + 3) nor its tables were written.
      expect(await store.invoke('read')).toBe(before + 4);
      expect(await tableNames(scopeB)).not.toContain(PROBE_TABLE.name);
    });

    // L8: a store of another kind would be handed to this kind's import, and a destination
    // with no vertical has no store object to load into. Both refuse before any write.
    it('a restore whose store is of another kind writes nothing', async () => {
      const store = await host.getScopeStore(principal, tenant, scopeB, 'GRAPH');
      const before = Number(await store.invoke('read'));
      const dump = await host.admin.exportScope(staff, tenant, scopeB);
      await store.invoke('increment', { by: 2 });
      const refusal = await host.restoreScope(staff, tenant, scopeB, {
        ...dump,
        tables: [...dump.tables, PROBE_TABLE],
        stores: dump.stores.map((one) => ({ ...one, kind: 'other' })),
      }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(errorCodeOf(refusal)).toBe('conflict');
      expect(await store.invoke('read')).toBe(before + 2);
      expect(await tableNames(scopeB)).not.toContain(PROBE_TABLE.name);
    });

    // CodeRabbit on #2244: the host does not parse the dump it is handed, so a store with no
    // kind skipped the kind comparison above and was imported.
    it('a restore whose store names no kind writes nothing', async () => {
      const store = await host.getScopeStore(principal, tenant, scopeB, 'GRAPH');
      const before = Number(await store.invoke('read'));
      const dump = await host.admin.exportScope(staff, tenant, scopeB);
      await store.invoke('increment', { by: 2 });
      const refusal = await host.restoreScope(staff, tenant, scopeB, {
        ...dump,
        tables: [...dump.tables, PROBE_TABLE],
        stores: dump.stores.map(({ binding, tables }) => ({ binding, tables })) as unknown as typeof dump.stores,
      }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(errorCodeOf(refusal)).toBe('validation_failed');
      expect(await store.invoke('read')).toBe(before + 2);
      expect(await tableNames(scopeB)).not.toContain(PROBE_TABLE.name);
    });

    it('a dump carrying stores is refused, not dropped, by a scope with no vertical', async () => {
      const bare = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: tenant, scopeId: bare });
      await host.admin.activateScope(staff, tenant, bare);
      const dump = await host.admin.exportScope(staff, tenant, scopeA);
      expect(dump.stores.length).toBeGreaterThan(0);
      const restored = await host.restoreScope(staff, tenant, bare, { ...dump, tables: [...dump.tables, PROBE_TABLE] }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(errorCodeOf(restored)).toBe('conflict');
      expect(await tableNames(bare)).not.toContain(PROBE_TABLE.name);
      const dest = scopeId.parse(ulid());
      const imported = await host.importScope(staff, { tenantId: tenant, scopeId: dest }, dump).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(errorCodeOf(imported)).toBe('conflict');
      expect(await host.admin.getScopeRecord(staff, tenant, dest)).toBeUndefined();
    });

    // The scope's tables load before its stores: a dump whose tables cannot load leaves the
    // store as it was, rather than replaced under tables that never arrived.
    it('a restore whose tables cannot load leaves the store as it was', async () => {
      const store = await host.getScopeStore(principal, tenant, scopeA, 'GRAPH');
      const dump = await host.admin.exportScope(staff, tenant, scopeA);
      await store.invoke('increment', { by: 5 });
      const now = Number(await store.invoke('read'));
      const refusal = await host.restoreScope(staff, tenant, scopeA, {
        ...dump,
        tables: [...dump.tables, { name: 'unloadable', ddl: 'CREATE TABLE something_else (id TEXT)', columns: ['id'], rows: [] }],
      }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(refusal).toBeDefined();
      expect(await store.invoke('read')).toBe(now);
    });

    it('a dump that names an unbound store is refused before a scope is created', async () => {
      const dump = await host.admin.exportScope(staff, tenant, scopeA);
      const dest = scopeId.parse(ulid());
      const refusal = await host.importScope(staff, {
        tenantId: tenant,
        scopeId: dest,
        vertical: 'docs',
      }, { ...dump, stores: [...dump.stores, { binding: 'MISSING', kind: 'counter', tables: [] }] }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(errorCodeOf(refusal)).toBe('not_found');
      expect(await host.admin.getScopeRecord(staff, tenant, dest)).toBeUndefined();
    });

    it('deleting a fork whose wipe fails leaves the fork and its storage', async () => {
      const fork = await host.snapshotScope(staff, tenant, scopeA);
      const seeded = await host.admin.exportScope(staff, tenant, fork);
      await host.restoreScope(staff, tenant, fork, { ...seeded, tables: [...seeded.tables, PROBE_TABLE] });
      const store = await host.getScopeStore(principal, tenant, fork, 'GRAPH');
      await store.invoke('fail-wipe', true);
      try {
        const refusal = await host.deleteSnapshot(staff, tenant, fork).then(
          () => undefined,
          (err: unknown) => err,
        );
        expect(refusal).toBeDefined();
        expect(await host.admin.getScopeRecord(staff, tenant, fork)).toBeDefined();
        expect(await tableNames(fork)).toContain(PROBE_TABLE.name);
      } finally {
        await store.invoke('fail-wipe', false);
      }
      await host.deleteSnapshot(staff, tenant, fork);
    });

    it('deleting a fork wipes its store', async () => {
      const fork = await host.snapshotScope(staff, tenant, scopeA);
      await host.deleteSnapshot(staff, tenant, fork);
      const live = await host.getScopeStore(principal, tenant, scopeA, 'GRAPH');
      const names = await live.invoke('wiped');
      expect(names).toContain(`${tenant}/docs/${fork}/GRAPH`);
    });

    // L7: the wipe runs before the scope's storage goes, so a wipe that fails leaves the
    // scope archived and its data where it was, and the reap converges on a retry.
    it('a reap whose wipe fails leaves the scope archived and its data intact', async () => {
      const doomed = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: tenant, scopeId: doomed, vertical: 'docs' });
      await host.admin.activateScope(staff, tenant, doomed);
      const store = await host.getScopeStore(principal, tenant, doomed, 'GRAPH');
      await store.invoke('increment', { by: 7 });
      // A table in the scope's own storage, so its survival is visible as well as the store's.
      const seeded = await host.admin.exportScope(staff, tenant, doomed);
      await host.restoreScope(staff, tenant, doomed, { ...seeded, tables: [...seeded.tables, PROBE_TABLE] });
      expect(await tableNames(doomed)).toContain(PROBE_TABLE.name);
      await host.admin.archiveScope(staff, tenant, doomed);
      await store.invoke('fail-wipe', true);
      try {
        const refusal = await host.admin.reapScope(staff, tenant, doomed).then(
          () => undefined,
          (err: unknown) => err,
        );
        expect(refusal).toBeDefined();
        expect((await host.admin.getScopeRecord(staff, tenant, doomed))?.status).toBe('archived');
        const dump = await host.admin.exportScope(staff, tenant, doomed);
        expect(dump.stores.find((one) => one.binding === 'GRAPH')?.tables[0]?.rows).toEqual([[7]]);
        expect(dump.tables.map((table) => table.name)).toContain(PROBE_TABLE.name);
      } finally {
        await store.invoke('fail-wipe', false);
      }
      await host.admin.reapScope(staff, tenant, doomed);
      expect((await host.admin.getScopeRecord(staff, tenant, doomed))?.status).toBe('reaped');
    });

    it('reaping a scope wipes its store', async () => {
      await host.admin.archiveScope(staff, tenant, scopeB);
      await host.admin.reapScope(staff, tenant, scopeB);
      const live = await host.getScopeStore(principal, tenant, scopeA, 'GRAPH');
      const names = await live.invoke('wiped');
      expect(names).toContain(`${tenant}/docs/${scopeB}/GRAPH`);
    });

    it('a store call is reported without its input, and a thrown observer does not fail it', async () => {
      const reports: StoreCallReport[] = [];
      const store = await host.getScopeStore(principal, tenant, scopeA, 'GRAPH', {
        onStoreCall: (report) => reports.push(report),
      });
      const secret = 'store-call-secret-value';
      await store.invoke('increment', { by: 1, note: secret });
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ binding: 'GRAPH', operation: 'increment', outcome: 'ok' });
      expect(reports[0]?.durationMs).toBeGreaterThanOrEqual(0);
      expect(Object.keys(reports[0] ?? {}).sort()).toEqual(['binding', 'durationMs', 'operation', 'outcome']);
      expect(JSON.stringify(reports)).not.toContain(secret);
      const refusal = await store.invoke('missing', { note: secret }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(refusal).toBeDefined();
      expect(reports[1]).toMatchObject({ binding: 'GRAPH', operation: 'missing', outcome: 'error' });
      expect(JSON.stringify(reports)).not.toContain(secret);
      const loud = await host.getScopeStore(principal, tenant, scopeA, 'GRAPH', {
        onStoreCall() {
          throw new Error('observer');
        },
      });
      expect(await loud.invoke('read')).toEqual(expect.any(Number));
    });

    it('with no observer, a call lands on the request now running; a passed one wins (#2245)', async () => {
      // The platform entry installs this slot (vertical-host's `runRecordingStoreCalls`);
      // here a fixed tally stands in for the request's record.
      const key = Symbol.for(STORE_CALL_SINK_KEY);
      const g = globalThis as unknown as Record<symbol, unknown>;
      const before = g[key];
      const current: StoreCallTally = {};
      g[key] = { current: () => (call: StoreCallReport) => tallyStoreCall(current, call) };
      try {
        const secret = 'store-call-secret-value';
        const store = await host.getScopeStore(principal, tenant, scopeA, 'GRAPH');
        await store.invoke('increment', { by: 1, note: secret });
        await store.invoke('missing', { note: secret }).catch(() => undefined);
        expect(current.storeCalls).toEqual([
          { binding: 'GRAPH', operation: 'increment', outcome: 'ok', durationMs: expect.any(Number) },
          { binding: 'GRAPH', operation: 'missing', outcome: 'error', durationMs: expect.any(Number) },
        ]);
        expect(JSON.stringify(current)).not.toContain(secret);
        const heard: StoreCallReport[] = [];
        const own = await host.getScopeStore(principal, tenant, scopeA, 'GRAPH', { onStoreCall: (r) => heard.push(r) });
        await own.invoke('read');
        expect(heard.map((r) => r.operation)).toEqual(['read']);
        expect(current.storeCalls).toHaveLength(2);
      } finally {
        g[key] = before;
      }
    });

    it('a call outside any request is not logged and does not throw (#2245)', async () => {
      const key = Symbol.for(STORE_CALL_SINK_KEY);
      const g = globalThis as unknown as Record<symbol, unknown>;
      const before = g[key];
      try {
        g[key] = undefined;
        const store = await host.getScopeStore(principal, tenant, scopeA, 'GRAPH');
        expect(await store.invoke('read')).toEqual(expect.any(Number));
        g[key] = { current: () => undefined };
        expect(await store.invoke('read')).toEqual(expect.any(Number));
        g[key] = {
          current() {
            throw new Error('slot');
          },
        };
        expect(await store.invoke('read')).toEqual(expect.any(Number));
      } finally {
        g[key] = before;
      }
    });

    it('an operation name that is not a fixed label is refused before the call, and not reported (#2245)', async () => {
      const reports: StoreCallReport[] = [];
      const store = await host.getScopeStore(principal, tenant, scopeA, 'GRAPH', { onStoreCall: (r) => reports.push(r) });
      const count = await store.invoke('read');
      reports.length = 0;
      for (const name of ['incr:ement', 'incr ement', 'incr@ement', 'i'.repeat(65)]) {
        const refusal = await store.invoke(name).then(
          () => undefined,
          (err: unknown) => err,
        );
        expect(errorCodeOf(refusal), name).toBe('validation_failed');
      }
      expect(reports).toEqual([]);
      expect(await store.invoke('read')).toBe(count);
    });

    it('a reserved operation is refused through the stub', async () => {
      const store = await host.getScopeStore(principal, tenant, scopeA, 'GRAPH');
      const before = await store.invoke('read');
      const refusal = await store.invoke('substrat.wipe').then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(errorCodeOf(refusal)).toBe('forbidden');
      expect(await store.invoke('read')).toBe(before);
    });

    /*
     * #2207: a restore re-erases every tombstoned subject. Each case restores into a scope of
     * its own, so the count is exact: one `substrat.erase` per subject on the one binding.
     */
    describe('a restore replays erasures', () => {
      const fresh = async (t = tenant) => {
        const scope = scopeId.parse(ulid());
        await host.provisionScope(staff, { tenantId: t, scopeId: scope, vertical: 'docs' });
        await host.admin.activateScope(staff, t, scope);
        return scope;
      };
      const erasedIn = async (scope: ScopeId, t = tenant) =>
        (await host.getScopeStore(principal, t, scope, 'GRAPH')).invoke('erased');

      it('a scope with no store, on a host with stores, restores as it always did', async () => {
        const plain = scopeId.parse(ulid());
        await host.provisionScope(staff, { tenantId: tenant, scopeId: plain });
        await host.admin.activateScope(staff, tenant, plain);
        await host.admin.shredSubject(staff, tenant, plain, ulid());
        const dump = { ...(await host.admin.exportScope(staff, tenant, plain)), scopeId: scopeId.parse(ulid()) };
        expect(await host.restoreScope(staff, tenant, plain, dump)).toBeUndefined();
      });

      it('with a store, no tombstone and a known source, answers nothing: none had to be replayed', async () => {
        const scope = await fresh();
        const dump = await host.admin.exportScope(staff, tenant, scope);
        expect(await host.restoreScope(staff, tenant, scope, dump)).toBeUndefined();
      });

      it('re-erases a subject tombstoned in the restored scope', async () => {
        const scope = await fresh();
        const dump = await host.admin.exportScope(staff, tenant, scope);
        const subject = ulid();
        await host.admin.shredSubject(staff, tenant, scope, subject);
        expect(await host.restoreScope(staff, tenant, scope, dump)).toEqual({
          storeErasuresReplayed: 1,
          storeErasureIncomplete: false,
        });
      });

      it("onto another scope, re-erases the source's marks and the target's own", async () => {
        const source = await fresh();
        const target = await fresh();
        const fromSource = ulid();
        const fromTarget = ulid();
        await host.admin.shredSubject(staff, tenant, source, fromSource);
        await host.admin.shredSubject(staff, tenant, target, fromTarget);
        const dump = await host.admin.exportScope(staff, tenant, source);
        expect(await host.restoreScope(staff, tenant, target, dump)).toEqual({
          storeErasuresReplayed: 2,
          storeErasureIncomplete: false,
        });
        expect(await erasedIn(target)).toEqual(expect.arrayContaining([fromSource, fromTarget]));
      });

      it('from a source this host does not know, restores and says the replay is incomplete', async () => {
        const target = await fresh();
        const store = await host.getScopeStore(principal, tenant, target, 'GRAPH');
        await store.invoke('increment', { by: 7 });
        const own = ulid();
        await host.admin.shredSubject(staff, tenant, target, own);
        const dump = { ...(await host.admin.exportScope(staff, tenant, target)), scopeId: scopeId.parse(ulid()) };
        await store.invoke('increment', { by: 1 });
        expect(await host.restoreScope(staff, tenant, target, dump)).toEqual({
          storeErasuresReplayed: 1,
          storeErasureIncomplete: true,
          storeErasureSourceUnknown: true,
        });
        // The data landed, and the target's own mark was still replayed.
        expect(await store.invoke('read')).toBe(7);
        expect(await erasedIn(target)).toContain(own);
      });

      it("never reads another tenant's marks: that source is unknown here", async () => {
        const other = tenantId.parse(ulid());
        await host.admin.createTenant(staff, { id: other, slug: `t-${other.toLowerCase()}`, name: 'Other' });
        const elsewhere = await fresh(other);
        const theirs = ulid();
        await host.admin.shredSubject(staff, other, elsewhere, theirs);
        const target = await fresh();
        const dump = { ...(await host.admin.exportScope(staff, tenant, target)), scopeId: elsewhere };
        expect(await host.restoreScope(staff, tenant, target, dump)).toEqual({
          storeErasuresReplayed: 0,
          storeErasureIncomplete: true,
          storeErasureSourceUnknown: true,
        });
        expect(await erasedIn(target)).not.toContain(theirs);
      });

      it('from a reaped source, still replays its marks: a reap keeps the directory row', async () => {
        const source = await fresh();
        const subject = ulid();
        await host.admin.shredSubject(staff, tenant, source, subject);
        const dump = await host.admin.exportScope(staff, tenant, source);
        await host.admin.archiveScope(staff, tenant, source);
        await host.admin.reapScope(staff, tenant, source);
        const target = await fresh();
        expect(await host.restoreScope(staff, tenant, target, dump)).toEqual({
          storeErasuresReplayed: 1,
          storeErasureIncomplete: false,
        });
        expect(await erasedIn(target)).toContain(subject);
      });

      it('from a deleted snapshot, restores and says the replay is incomplete: the row is gone', async () => {
        const fork = await host.snapshotScope(staff, tenant, await fresh());
        const subject = ulid();
        await host.admin.shredSubject(staff, tenant, fork, subject);
        const dump = await host.admin.exportScope(staff, tenant, fork);
        await host.deleteSnapshot(staff, tenant, fork);
        const target = await fresh();
        expect(await host.restoreScope(staff, tenant, target, dump)).toEqual({
          storeErasuresReplayed: 0,
          storeErasureIncomplete: true,
          storeErasureSourceUnknown: true,
        });
        expect(await erasedIn(target)).not.toContain(subject);
      });
    });
  });
}
