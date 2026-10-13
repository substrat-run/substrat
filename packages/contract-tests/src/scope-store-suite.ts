import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { errorCodeOf, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type ScopeHost, type ScopeStoreAddress, type ScopeStoreRunner } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';

/**
 * A counter in the process. One number per address, so two scopes and two
 * verticals stay apart when the host passes the address it built.
 */
function counterRunner(): ScopeStoreRunner {
  const objects = new Map<string, number>();
  const erased = new Map<string, Set<string>>();
  const wiped = new Set<string>();
  const key = (address: ScopeStoreAddress) =>
    `${address.tenantId}/${address.vertical}/${address.scopeId}/${address.binding}`;
  return {
    kind: 'counter',
    async start() {},
    async stop() {},
    async invoke(address, request) {
      const current = objects.get(key(address)) ?? 0;
      if (request.operation === 'read') return { result: current };
      if (request.operation === 'address') {
        return {
          result: {
            tenantId: address.tenantId,
            vertical: address.vertical,
            scopeId: address.scopeId,
            binding: address.binding,
          },
        };
      }
      if (request.operation === 'increment') {
        const by =
          typeof request.input === 'object' &&
          request.input !== null &&
          typeof Reflect.get(request.input, 'by') === 'number'
            ? Number(Reflect.get(request.input, 'by'))
            : 1;
        const next = current + by;
        objects.set(key(address), next);
        return { result: next };
      }
      if (request.operation === 'substrat.size') return { result: { bytes: current } };
      if (request.operation === 'substrat.wipe') {
        objects.set(key(address), 0);
        wiped.add(key(address));
        return { result: {} };
      }
      if (request.operation === 'wiped') return { result: [...wiped] };
      if (request.operation === 'substrat.erase') {
        const subjectId =
          typeof request.input === 'object' && request.input !== null
            ? Reflect.get(request.input, 'subjectId')
            : undefined;
        if (typeof subjectId !== 'string' || subjectId.length === 0) {
          return { error: { code: 'validation_failed', status: 400 } };
        }
        const subjects = erased.get(key(address)) ?? new Set<string>();
        const already = subjects.has(subjectId);
        subjects.add(subjectId);
        erased.set(key(address), subjects);
        return { result: { erased: already ? 0 : 1 } };
      }
      if (request.operation === 'erased') {
        return { result: [...(erased.get(key(address)) ?? [])] };
      }
      if (request.operation === 'substrat.export') {
        return {
          result: {
            tables: [
              {
                name: 'counter',
                ddl: 'CREATE TABLE counter (n INTEGER NOT NULL)',
                columns: ['n'],
                rows: [[current]],
              },
            ],
          },
        };
      }
      if (request.operation === 'substrat.import') {
        const tables =
          typeof request.input === 'object' && request.input !== null
            ? Reflect.get(request.input, 'tables')
            : undefined;
        const count = Array.isArray(tables) ? tables.length : 0;
        const first = Array.isArray(tables) ? tables[0] : undefined;
        const rows = typeof first === 'object' && first !== null ? Reflect.get(first, 'rows') : undefined;
        const row = Array.isArray(rows) ? rows[0] : undefined;
        const cell = Array.isArray(row) ? row[0] : undefined;
        objects.set(key(address), typeof cell === 'number' ? cell : 0);
        return { result: { tables: count } };
      }
      return { error: { code: 'unknown_operation', status: 400 } };
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
      fixture = await makeFixture({ runners: [{ binding: 'GRAPH', runner: counterRunner() }] });
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
        stores: [...dump.stores, { binding: 'MISSING', kind: 'counter', tables: [] }],
      }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(errorCodeOf(refusal)).toBe('not_found');
      // Neither the restore of the dump's GRAPH (before + 3) nor anything else was written.
      expect(await store.invoke('read')).toBe(before + 4);
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

    it('deleting a fork wipes its store', async () => {
      const fork = await host.snapshotScope(staff, tenant, scopeA);
      await host.deleteSnapshot(staff, tenant, fork);
      const live = await host.getScopeStore(principal, tenant, scopeA, 'GRAPH');
      const names = await live.invoke('wiped');
      expect(names).toContain(`${tenant}/docs/${fork}/GRAPH`);
    });

    it('reaping a scope wipes its store', async () => {
      await host.admin.archiveScope(staff, tenant, scopeB);
      await host.admin.reapScope(staff, tenant, scopeB);
      const live = await host.getScopeStore(principal, tenant, scopeA, 'GRAPH');
      const names = await live.invoke('wiped');
      expect(names).toContain(`${tenant}/docs/${scopeB}/GRAPH`);
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
  });
}
