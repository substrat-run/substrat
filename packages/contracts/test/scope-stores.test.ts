import { describe, expect, it } from 'vitest';
import {
  RESERVED_STORE_OPERATIONS,
  assertDeclaredScopeStores,
  assertScopeStoresRegistered,
  assertStoreBindingsDistinct,
  deployManifest,
  runtimeNeeds,
  scopeStoreBindingName,
  STORE_KINDS,
  storeKindId,
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
        className: 'Store',
        operations: ['read'],
        platformOperations: reserved,
      }),
    ).toThrow(/substrat.erase/);
  });

  it('holds a kind id to [a-z0-9]+ (L20), at the registration and in every registered kind', () => {
    const registration = (kind: string) => ({
      kind,
      release: '1.0.0',
      className: 'Store',
      operations: ['read'],
      platformOperations: [...RESERVED_STORE_OPERATIONS],
    });
    for (const kind of ['graph-x', 'graph_x', 'Graph', 'gr aph', '']) {
      expect(storeKindId.safeParse(kind).success, kind).toBe(false);
      const parsed = storeKindRegistration.safeParse(registration(kind));
      expect(parsed.success, kind).toBe(false);
      expect(JSON.stringify(parsed.error?.issues), kind).toContain('[a-z0-9]+');
    }
    // The twin: ids in the grammar parse, and the registered kind is one.
    for (const kind of ['graph', 'g2', '0']) expect(storeKindId.safeParse(kind).success, kind).toBe(true);
    expect(storeKindRegistration.safeParse(registration('graph')).success).toBe(true);
    for (const kind of STORE_KINDS) expect(storeKindRegistration.safeParse(kind).success, kind.kind).toBe(true);
  });

  it('refuses a catalog operation on the reserved prefix', () => {
    expect(() =>
      storeKindRegistration.parse({
        kind: 'graph',
        release: '1.0.0',
        className: 'Store',
        operations: ['substrat.wipe'],
        platformOperations: [...RESERVED_STORE_OPERATIONS],
      }),
    ).toThrow(/substrat/);
  });
});
