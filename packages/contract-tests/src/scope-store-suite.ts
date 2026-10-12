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
  const key = (address: ScopeStoreAddress) =>
    `${address.tenantId}/${address.vertical}/${address.scopeId}/${address.binding}`;
  return {
    kind: 'counter',
    async start() {},
    async stop() {},
    async invoke(address, request) {
      const current = objects.get(key(address)) ?? 0;
      if (request.operation === 'read') return { result: current };
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
