import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, scopeStoreNeed, tenantId } from '@substrat-run/contracts';
import { counterScopeStoreRunner } from '@substrat-run/contract-tests';
import { ulid, UNSAFE_allowAllChecker, type ScopeStoreRunner } from '@substrat-run/kernel';
import { SqliteScopeHost, scopeStoreRunnersFor } from '../src/index.js';

/** The counter under another driver id, the way a driver's runner would be named. */
const runnerOfDriver = (driver: string): ScopeStoreRunner => ({ ...counterScopeStoreRunner(), driver });

describe('scopeStoreRunnersFor (#2213)', () => {
  it('gives each declared binding the runner of its driver', () => {
    const graph = runnerOfDriver('graph');
    const declared = [scopeStoreNeed.parse({ binding: 'GRAPH', driver: 'graph' })];
    expect(scopeStoreRunnersFor(declared, { graph })).toEqual([{ binding: 'GRAPH', runner: graph }]);
  });

  it('two bindings of one driver share its runner', () => {
    const graph = runnerOfDriver('graph');
    const runners = scopeStoreRunnersFor(
      [
        { binding: 'A', driver: 'graph' },
        { binding: 'B', driver: 'graph' },
      ],
      { graph },
    );
    expect(runners.map((one) => one.runner)).toEqual([graph, graph]);
  });

  it('no declaration gives no runners, and a runner for an undeclared driver is unused', () => {
    expect(scopeStoreRunnersFor([], { graph: runnerOfDriver('graph') })).toEqual([]);
  });

  it('refuses a declared driver with no runner', () => {
    expect(() => scopeStoreRunnersFor([{ binding: 'GRAPH', driver: 'graph' }], {})).toThrow(
      /'GRAPH' is declared as driver 'graph', and no runner is given/,
    );
  });

  it('refuses an inherited key as a runner', () => {
    expect(() => scopeStoreRunnersFor([{ binding: 'GRAPH', driver: 'toString' }], {})).toThrow(/no runner is given/);
  });

  it('refuses a runner given under a key that is not its driver', () => {
    expect(() =>
      scopeStoreRunnersFor([{ binding: 'GRAPH', driver: 'graph' }], { graph: runnerOfDriver('counter') }),
    ).toThrow(/driver 'graph' is driver 'counter'/);
  });

  it('a host built from it answers each declared binding from its own object', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-scope-store-runners-'));
    const host = new SqliteScopeHost({
      dir,
      checker: UNSAFE_allowAllChecker,
      scopeStores: {
        runners: scopeStoreRunnersFor(
          [
            { binding: 'A', driver: 'counter' },
            { binding: 'B', driver: 'counter' },
          ],
          { counter: counterScopeStoreRunner() },
        ),
      },
    });
    try {
      const staff = platformActorId.parse(ulid());
      const principal = principalId.parse(ulid());
      const tenant = tenantId.parse(ulid());
      const scope = scopeId.parse(ulid());
      await host.admin.createTenant(staff, { id: tenant, slug: `t-${tenant.toLowerCase()}`, name: 'T' });
      await host.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'docs' });
      await host.admin.activateScope(staff, tenant, scope);
      const a = await host.getScopeStore(principal, tenant, scope, 'A');
      const b = await host.getScopeStore(principal, tenant, scope, 'B');
      expect(await a.invoke('increment', { by: 3 })).toBe(3);
      expect(await b.invoke('read')).toBe(0);
      expect(await host.admin.scopeStoreSizes(staff, tenant, scope)).toEqual([
        { binding: 'A', bytes: 3 },
        { binding: 'B', bytes: 0 },
      ]);
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
