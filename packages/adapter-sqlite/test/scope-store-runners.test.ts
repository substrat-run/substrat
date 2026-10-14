import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, scopeStoreNeed, tenantId } from '@substrat-run/contracts';
import { counterScopeStoreRunner } from '@substrat-run/contract-tests';
import { ulid, UNSAFE_allowAllChecker, type ScopeStoreRunner } from '@substrat-run/kernel';
import { SqliteScopeHost, scopeStoreRunnersFor } from '../src/index.js';

/** The counter under another kind id, the way a kind's runner would be named. */
const runnerOfKind = (kind: string): ScopeStoreRunner => ({ ...counterScopeStoreRunner(), kind });

describe('scopeStoreRunnersFor (#2213)', () => {
  it('gives each declared binding the runner of its kind', () => {
    const graph = runnerOfKind('graph');
    const declared = [scopeStoreNeed.parse({ binding: 'GRAPH', kind: 'graph' })];
    expect(scopeStoreRunnersFor(declared, { graph })).toEqual([{ binding: 'GRAPH', runner: graph }]);
  });

  it('two bindings of one kind share its runner', () => {
    const graph = runnerOfKind('graph');
    const runners = scopeStoreRunnersFor(
      [
        { binding: 'A', kind: 'graph' },
        { binding: 'B', kind: 'graph' },
      ],
      { graph },
    );
    expect(runners.map((one) => one.runner)).toEqual([graph, graph]);
  });

  it('no declaration gives no runners, and a runner for an undeclared kind is unused', () => {
    expect(scopeStoreRunnersFor([], { graph: runnerOfKind('graph') })).toEqual([]);
  });

  it('refuses a declared kind with no runner', () => {
    expect(() => scopeStoreRunnersFor([{ binding: 'GRAPH', kind: 'graph' }], {})).toThrow(
      /'GRAPH' is declared as kind 'graph', and no runner is given/,
    );
  });

  it('refuses an inherited key as a runner', () => {
    expect(() => scopeStoreRunnersFor([{ binding: 'GRAPH', kind: 'toString' }], {})).toThrow(/no runner is given/);
  });

  it('refuses a runner given under a key that is not its kind', () => {
    expect(() =>
      scopeStoreRunnersFor([{ binding: 'GRAPH', kind: 'graph' }], { graph: runnerOfKind('counter') }),
    ).toThrow(/kind 'graph' is kind 'counter'/);
  });

  it('a host built from it answers each declared binding from its own object', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-scope-store-runners-'));
    const host = new SqliteScopeHost({
      dir,
      checker: UNSAFE_allowAllChecker,
      scopeStores: {
        runners: scopeStoreRunnersFor(
          [
            { binding: 'A', kind: 'counter' },
            { binding: 'B', kind: 'counter' },
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
