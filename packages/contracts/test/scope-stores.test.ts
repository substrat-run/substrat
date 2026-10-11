import { describe, expect, it } from 'vitest';
import {
  RESERVED_STORE_OPERATIONS,
  assertDeclaredScopeStores,
  assertScopeStoresRegistered,
  assertStoreBindingsDistinct,
  deployManifest,
  runtimeNeeds,
  scopeStoreBindingName,
  storeKindRegistration,
} from '../src/index.js';

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

  it('accepts ontomate and carries it on the manifest', () => {
    const needs = runtimeNeeds.parse({
      entry: 'src/worker.ts',
      scopeStores: [{ binding: 'GRAPH', kind: 'ontomate' }],
    });
    expect(needs.scopeStores).toEqual([{ binding: 'GRAPH', kind: 'ontomate' }]);
    expect(
      deployManifest.parse({ ...baseManifest, scopeStores: needs.scopeStores }).scopeStores,
    ).toEqual([{ binding: 'GRAPH', kind: 'ontomate' }]);
  });

  it('refuses a kind other than ontomate', () => {
    expect(() =>
      runtimeNeeds.parse({ entry: 'src/worker.ts', scopeStores: [{ binding: 'GRAPH', kind: 'graph' }] }),
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
        scopeStores: [
          { binding: 'GRAPH', kind: 'ontomate' },
          { binding: 'GRAPH', kind: 'ontomate' },
        ],
      }),
    ).toThrow(/binding 'GRAPH' is declared as/);
    expect(() =>
      assertStoreBindingsDistinct({
        tenantStores: [{ binding: 'FILES', kind: 'relational' }],
        scopeStores: [{ binding: 'FILES', kind: 'ontomate' }],
      }),
    ).toThrow(/binding 'FILES' is declared as/);
    expect(() =>
      assertStoreBindingsDistinct({
        own: [{ binding: 'SCOPE' }],
        scopeStores: [{ binding: 'SCOPE', kind: 'ontomate' }],
      }),
    ).toThrow(/binding 'SCOPE' is declared as/);
  });

  it('refuses ATTACHMENTS as a scope store', () => {
    expect(() =>
      assertStoreBindingsDistinct({ scopeStores: [{ binding: 'ATTACHMENTS', kind: 'ontomate' }] }),
    ).toThrow(/attachment blob store/);
  });

  it('refuses ontomate while no kind is registered', () => {
    const stores = [{ binding: 'GRAPH', kind: 'ontomate' as const }];
    expect(() => assertScopeStoresRegistered(stores)).toThrow(/not registered/);
    expect(() => assertDeclaredScopeStores({ scopeStores: stores })).toThrow(/not registered/);
  });

  it('refuses a registration that does not answer substrat.erase', () => {
    const reserved = RESERVED_STORE_OPERATIONS.filter((op) => op !== 'substrat.erase');
    expect(() =>
      storeKindRegistration.parse({
        kind: 'ontomate',
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
        kind: 'ontomate',
        release: '1.0.0',
        script: 'store',
        className: 'Store',
        operations: ['substrat.wipe'],
        platformOperations: [...RESERVED_STORE_OPERATIONS],
      }),
    ).toThrow(/substrat/);
  });
});
