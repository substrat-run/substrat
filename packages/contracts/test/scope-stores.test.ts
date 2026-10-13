import { describe, expect, it } from 'vitest';
import {
  RESERVED_STORE_OPERATIONS,
  assertDeclaredScopeStores,
  assertScopeStoresRegistered,
  assertStoreBindingsDistinct,
  deployManifest,
  mayHoldScopeStores,
  scopeStoresDeclaredIn,
  STORE_KINDS,
  type StoreKindRegistration,
  runtimeNeeds,
  scopeStoreBindingName,
  storeKindRegistration,
  tenantStoreBindingName,
} from '../src/index.js';

/** A tenant id the per-tenant runtime name can be built from. */
const TENANT = '01JTESTATTACHTENANT000000A';

const baseManifest = {
  version: '1.0.0',
  entry: 'index.js',
  compatibilityDate: '2026-07-01',
  registry: { permissions: [], roles: [], entityGrants: [] },
  digests: { manifest: 'm', permission: 'p', migration: 'g' },
};

describe('a scope store is declared by binding and kind (#2208)', () => {
  it('defaults to no scope stores', () => {
    expect(runtimeNeeds.parse({ entry: 'src/worker.ts' }).scopeStores).toEqual([]);
    expect(deployManifest.parse(baseManifest).scopeStores).toEqual([]);
  });

  it('accepts graph and carries it on the manifest', () => {
    const needs = runtimeNeeds.parse({
      entry: 'src/worker.ts',
      scopeStores: [{ binding: 'GRAPH', kind: 'graph' }],
    });
    expect(needs.scopeStores).toEqual([{ binding: 'GRAPH', kind: 'graph' }]);
    expect(
      deployManifest.parse({ ...baseManifest, scopeStores: needs.scopeStores }).scopeStores,
    ).toEqual([{ binding: 'GRAPH', kind: 'graph' }]);
  });

  it('refuses a kind other than graph', () => {
    expect(() =>
      runtimeNeeds.parse({ entry: 'src/worker.ts', scopeStores: [{ binding: 'GRAPH', kind: 'document' }] }),
    ).toThrow();
  });

  it('refuses a scope store that omits its kind', () => {
    expect(() =>
      runtimeNeeds.parse({ entry: 'src/worker.ts', scopeStores: [{ binding: 'GRAPH' }] }),
    ).toThrow();
  });

  it('names the injected binding SUBSTRAT_STORE_<BINDING>', () => {
    expect(scopeStoreBindingName('GRAPH')).toBe('SUBSTRAT_STORE_GRAPH');
    expect(() => scopeStoreBindingName('graph')).toThrow(/not a scope-store binding name/);
  });

  it('refuses a binding declared twice, including across store lists', () => {
    expect(() =>
      assertStoreBindingsDistinct({
        scopeStores: [{ binding: 'GRAPH' }, { binding: 'GRAPH' }],
      }),
    ).toThrow(/binding 'GRAPH' is declared as/);
    expect(() =>
      assertStoreBindingsDistinct({
        tenantStores: [{ binding: 'FILES' }],
        scopeStores: [{ binding: 'FILES' }],
      }),
    ).toThrow(/binding 'FILES' is declared as/);
    expect(() =>
      assertStoreBindingsDistinct({
        own: [{ binding: 'SCOPE' }],
        scopeStores: [{ binding: 'SCOPE' }],
      }),
    ).toThrow(/binding 'SCOPE' is declared as/);
  });

  it('compares a static binding to the name that lands on the worker', () => {
    // The declared spelling is not the injected binding. DB becomes DB__<tenant>,
    // GRAPH becomes SUBSTRAT_STORE_GRAPH, so a static binding of the declared
    // spelling is a different store.
    expect(() =>
      assertStoreBindingsDistinct({
        tenantStores: [{ binding: 'DB' }],
        bindingNames: ['DB'],
      }),
    ).not.toThrow();
    expect(() =>
      assertStoreBindingsDistinct({
        scopeStores: [{ binding: 'GRAPH' }],
        bindingNames: ['GRAPH'],
      }),
    ).not.toThrow();
    expect(() =>
      assertStoreBindingsDistinct({
        tenantStores: [{ binding: 'DB' }],
        bindingNames: [tenantStoreBindingName('DB', TENANT)],
      }),
    ).toThrow(/runtime name of per-tenant store 'DB'/);
    expect(() =>
      assertStoreBindingsDistinct({
        scopeStores: [{ binding: 'GRAPH' }],
        bindingNames: [scopeStoreBindingName('GRAPH')],
      }),
    ).toThrow(/runtime name of scope store 'GRAPH'/);
    expect(() =>
      assertStoreBindingsDistinct({
        own: [{ binding: 'SCOPE' }],
        bindingNames: ['SCOPE'],
      }),
    ).toThrow(/an own store and as a static binding/);
  });

  it('refuses ATTACHMENTS as a scope store', () => {
    expect(() => assertStoreBindingsDistinct({ scopeStores: [{ binding: 'ATTACHMENTS' }] })).toThrow(
      /attachment blob store/,
    );
  });

  it('refuses graph while no kind is registered', () => {
    const stores = [{ binding: 'GRAPH', kind: 'graph' as const }];
    expect(() => assertScopeStoresRegistered(stores)).toThrow(/not registered/);
    expect(() => assertDeclaredScopeStores({ scopeStores: stores })).toThrow(/not registered/);
  });

  it('refuses a registration that does not answer substrat.erase', () => {
    const reserved = RESERVED_STORE_OPERATIONS.filter((op) => op !== 'substrat.erase');
    expect(() =>
      storeKindRegistration.parse({
        kind: 'graph',
        release: '1.0.0',
        script: 'store',
        className: 'Store',
        operations: ['read'],
        platformOperations: reserved,
      }),
    ).toThrow(/substrat.erase/);
  });

  it('refuses a catalog operation on the reserved prefix', () => {
    expect(() =>
      storeKindRegistration.parse({
        kind: 'graph',
        release: '1.0.0',
        script: 'store',
        className: 'Store',
        operations: ['substrat.wipe'],
        platformOperations: [...RESERVED_STORE_OPERATIONS],
      }),
    ).toThrow(/substrat/);
  });
});

// #2242: subject erasure destroys the key once the stores answer, so "cannot tell" must
// never read as "holds none". The gate is the registry: no registered kind, no store.
describe('mayHoldScopeStores / scopeStoresDeclaredIn (#2242)', () => {
  const graph: StoreKindRegistration = {
    kind: 'graph',
    release: '0.0.0-test',
    script: 'store-graph',
    className: 'GraphStore',
    operations: [],
    platformOperations: [...RESERVED_STORE_OPERATIONS],
  };
  const manifest = (scopeStores?: unknown[]) =>
    JSON.stringify({
      version: '1.0.0',
      entry: 'index.js',
      compatibilityDate: '2026-07-01',
      registry: { permissions: [], roles: [], entityGrants: [] },
      digests: { manifest: 'm', permission: 'p', migration: 'g' },
      ...(scopeStores ? { scopeStores } : {}),
    });
  const declaring = manifest([{ binding: 'GRAPH', kind: 'graph' }]);

  it('reads a manifest: declares, declares none, predates manifests, unreadable', () => {
    expect(scopeStoresDeclaredIn(declaring)).toBe(true);
    expect(scopeStoresDeclaredIn(manifest())).toBe(false);
    expect(scopeStoresDeclaredIn(null)).toBe(false);
    expect(scopeStoresDeclaredIn('{not json')).toBeUndefined();
    expect(scopeStoresDeclaredIn(JSON.stringify({ version: 1 }))).toBeUndefined();
  });

  it('with no kind registered nothing may hold a store, whatever the manifest says', () => {
    expect(STORE_KINDS).toEqual([]);
    for (const json of [declaring, manifest(), null, undefined, '{not json']) {
      expect(mayHoldScopeStores(json)).toBe(false);
    }
  });

  it('with a kind registered, unknown and unreadable count as may, and only a known "none" does not', () => {
    expect(mayHoldScopeStores(declaring, [graph])).toBe(true);
    expect(mayHoldScopeStores(undefined, [graph])).toBe(true);
    expect(mayHoldScopeStores('{not json', [graph])).toBe(true);
    expect(mayHoldScopeStores(JSON.stringify({ version: 1 }), [graph])).toBe(true);
    expect(mayHoldScopeStores(manifest(), [graph])).toBe(false);
    expect(mayHoldScopeStores(null, [graph])).toBe(false);
  });
});
