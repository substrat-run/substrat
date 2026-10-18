import { describe, expect, it } from 'vitest';
import {
  HISTORIC_ADMIN_ACTIONS,
  RESERVED_STORE_OPERATIONS,
  SCOPE_STORE_DUMP_KIND_RENAMED,
  adminAction,
  scopeDump,
  assertDeclaredScopeStores,
  assertScopeStoresRegistered,
  assertStoreBindingsDistinct,
  deployManifest,
  mayHoldScopeStores,
  scopeStoresDeclaredIn,
  STORE_DRIVERS,
  type StoreDriverRegistration,
  runtimeNeeds,
  scopeStoreBindingName,
  scopeStoreNeed,
  SCOPE_STORE_KIND_RENAMED,
  storeDriverId,
  storeDriverRegistration,
  storeDriverReleaseDigest,
  storeOperationName,
  storeRequest,
  STORE_OPERATION_NAME_MAX,
  tenantStoreBindingName,
  storeEraseResult,
  storeExportResult,
  storeImportResult,
  storeSizeResult,
  storeWipeResult,
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

describe('a scope store is declared by binding and driver (#2208)', () => {
  it('defaults to no scope stores', () => {
    expect(runtimeNeeds.parse({ entry: 'src/worker.ts' }).scopeStores).toEqual([]);
    expect(deployManifest.parse(baseManifest).scopeStores).toEqual([]);
  });

  it('accepts graph and carries it on the manifest', () => {
    const needs = runtimeNeeds.parse({
      entry: 'src/worker.ts',
      scopeStores: [{ binding: 'GRAPH', driver: 'graph' }],
    });
    expect(needs.scopeStores).toEqual([{ binding: 'GRAPH', driver: 'graph' }]);
    expect(
      deployManifest.parse({ ...baseManifest, scopeStores: needs.scopeStores }).scopeStores,
    ).toEqual([{ binding: 'GRAPH', driver: 'graph' }]);
  });

  it('refuses a driver other than graph', () => {
    expect(() =>
      runtimeNeeds.parse({ entry: 'src/worker.ts', scopeStores: [{ binding: 'GRAPH', driver: 'document' }] }),
    ).toThrow();
  });

  it('refuses a scope store that omits its driver', () => {
    expect(() =>
      runtimeNeeds.parse({ entry: 'src/worker.ts', scopeStores: [{ binding: 'GRAPH' }] }),
    ).toThrow();
  });

  // K-53's rename is a clean break: no alias, and the old spelling names the rename.
  it('refuses the pre-rename `kind`, naming the rename, in the declaration and on a stored manifest', () => {
    const old = { entry: 'src/worker.ts', scopeStores: [{ binding: 'GRAPH', kind: 'graph' }] };
    const needs = runtimeNeeds.safeParse(old);
    expect(needs.success).toBe(false);
    expect(needs.error?.issues.map((i) => i.message)).toContain(SCOPE_STORE_KIND_RENAMED);
    expect(needs.error?.issues.find((i) => i.message === SCOPE_STORE_KIND_RENAMED)?.path).toEqual(['scopeStores', 0, 'kind']);
    // Beside a `driver` too: the old key is never dropped silently.
    expect(() =>
      deployManifest.parse({ ...baseManifest, scopeStores: [{ binding: 'GRAPH', driver: 'graph', kind: 'graph' }] }),
    ).toThrow(/scopeStores\[\]\.kind was renamed driver/);
    // The twin: the new spelling parses, and the output carries no `kind` key.
    expect(Object.keys(scopeStoreNeed.parse({ binding: 'GRAPH', driver: 'graph' }))).toEqual(['binding', 'driver']);
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

  it('admits graph, the registered driver', () => {
    const stores = [{ binding: 'GRAPH', driver: 'graph' as const }];
    expect(() => assertScopeStoresRegistered(stores)).not.toThrow();
    expect(() => assertDeclaredScopeStores({ scopeStores: stores })).not.toThrow();
    expect(STORE_DRIVERS.map((driver) => driver.driver)).toEqual(['graph']);
    expect(STORE_DRIVERS[0]?.className).toBe('Store');
    expect(STORE_DRIVERS[0]?.operations).toHaveLength(35);
    expect(STORE_DRIVERS[0]?.releases).toEqual([
      {
        sha256: '1fb0bb0be73c05239b5e769280461c3049ef295f2f92cab90cba9c15ba5ad122',
        sourceCommit: 'f49ef6bb16691517a38fd36268ceb79834d6fbc6',
        schema: 0,
      },
    ]);
  });

  it('refuses a registration that does not answer substrat.erase', () => {
    const reserved = RESERVED_STORE_OPERATIONS.filter((op) => op !== 'substrat.erase');
    expect(() =>
      storeDriverRegistration.parse({
        driver: 'graph',
        releases: [{ sha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), schema: 0 }],
        className: 'Store',
        operations: ['read'],
        platformOperations: reserved,
      }),
    ).toThrow(/substrat.erase/);
  });

  it('holds a driver id to [a-z0-9]+ (L20), at the registration and in every registered driver', () => {
    const registration = (driver: string) => ({
      driver,
      releases: [{ sha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), schema: 0 }],
      className: 'Store',
      operations: ['read'],
      platformOperations: [...RESERVED_STORE_OPERATIONS],
    });
    for (const driver of ['graph-x', 'graph_x', 'Graph', 'gr aph', '']) {
      expect(storeDriverId.safeParse(driver).success, driver).toBe(false);
      const parsed = storeDriverRegistration.safeParse(registration(driver));
      expect(parsed.success, driver).toBe(false);
      expect(JSON.stringify(parsed.error?.issues), driver).toContain('[a-z0-9]+');
    }
    // The twin: ids in the grammar parse, and the registered driver is one.
    for (const driver of ['graph', 'g2', '0']) expect(storeDriverId.safeParse(driver).success, driver).toBe(true);
    expect(storeDriverRegistration.safeParse(registration('graph')).success).toBe(true);
    for (const driver of STORE_DRIVERS) expect(storeDriverRegistration.safeParse(driver).success, driver.driver).toBe(true);
  });

  it('refuses a catalog operation on the reserved prefix', () => {
    expect(() =>
      storeDriverRegistration.parse({
        driver: 'graph',
        releases: [{ sha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), schema: 0 }],
        className: 'Store',
        operations: ['substrat.wipe'],
        platformOperations: [...RESERVED_STORE_OPERATIONS],
      }),
    ).toThrow(/substrat/);
  });
});

describe('a store driver release is pinned by sha256 and source commit (D-63)', () => {
  const registration = (releases: unknown) => ({
    driver: 'graph',
    releases,
    className: 'GraphStore',
    operations: [],
    platformOperations: [...RESERVED_STORE_OPERATIONS],
  });
  const pin = { sha256: 'c'.repeat(64), sourceCommit: 'd'.repeat(40), schema: 0 };

  it('admits a list of pins, and refuses an empty list, a repeated pin, and a malformed one', () => {
    expect(storeDriverRegistration.safeParse(registration([pin, { ...pin, sha256: 'e'.repeat(64), schema: 3 }])).success).toBe(true);
    for (const releases of [
      [],
      [pin, { ...pin }],
      [{ ...pin, sha256: 'C'.repeat(64) }],
      [{ ...pin, sha256: 'c'.repeat(63) }],
      [{ ...pin, sourceCommit: 'd'.repeat(39) }],
      [{ sha256: pin.sha256 }],
      // The schema a release migrates to is part of its pin (#2300): required, an integer, not negative.
      [{ sha256: pin.sha256, sourceCommit: pin.sourceCommit }],
      [{ ...pin, schema: 1.5 }],
      [{ ...pin, schema: -1 }],
      [{ ...pin, schema: '1' }],
      [{ ...pin, release: '1.0.0' }],
      '1.0.0',
    ]) {
      expect(storeDriverRegistration.safeParse(registration(releases)).success, JSON.stringify(releases)).toBe(false);
    }
    // The registration that named a release by label is no longer one.
    expect(storeDriverRegistration.safeParse({ ...registration([pin]), releases: undefined, release: '1.0.0' }).success).toBe(false);
  });

  const text = (value: string) => new TextEncoder().encode(value);
  const modules = [
    { name: 'driver_graph/store.py', content: text('class GraphStore:\n    pass\n') },
    { name: 'driver_graph/__init__.py', content: new Uint8Array() },
  ];
  const bundle = { entry: 'driver_graph/store.py', modules };

  it('digests a release to a fixed vector, computed outside this code', async () => {
    // printf 'substrat.store-release/v1\000' 'driver_graph/store.py\000', then the modules in name
    // order: 'driver_graph/__init__.py\000' + 8 zero bytes, 'driver_graph/store.py\000' + 7 zero
    // bytes + '\033' + the 27 bytes of the module, piped to `shasum -a 256`.
    expect(await storeDriverReleaseDigest(bundle)).toBe('2a4399c86cd301f2944ac96cfcd9774c9fd3d12058df13a2ab20c46d51163038');
  });

  it('is the same digest in any order, and another for any other bytes, name, split or entry', async () => {
    const digest = await storeDriverReleaseDigest(bundle);
    expect(await storeDriverReleaseDigest({ ...bundle, modules: [...modules].reverse() })).toBe(digest);
    const others = [
      { ...bundle, modules: [modules[0]!, { ...modules[1]!, content: text(' ') }] },
      { entry: 'driver_graph/graph.py', modules: [{ ...modules[0]!, name: 'driver_graph/graph.py' }, modules[1]!] },
      { ...bundle, modules: [modules[0]!] },
      // The same modules, with the entry importing another one: another release (D-63).
      { ...bundle, entry: 'driver_graph/__init__.py' },
      // The same bytes split differently between two names.
      { entry: 'a', modules: [{ name: 'a', content: text('bc') }, { name: 'b', content: text('') }] },
    ];
    const seen = new Set([
      digest,
      await storeDriverReleaseDigest({ entry: 'a', modules: [{ name: 'a', content: text('b') }, { name: 'b', content: text('c') }] }),
    ]);
    for (const release of others) {
      const other = await storeDriverReleaseDigest(release);
      expect(seen.has(other), JSON.stringify([release.entry, release.modules.map((m) => m.name)])).toBe(false);
      seen.add(other);
    }
  });

  it('refuses a release that names a module twice, or whose entry is not one of its modules', async () => {
    await expect(storeDriverReleaseDigest({ ...bundle, modules: [modules[0]!, modules[0]!] })).rejects.toThrow(/twice/);
    await expect(storeDriverReleaseDigest({ ...bundle, entry: 'driver_graph/legacy.py' })).rejects.toThrow(/not one of its modules/);
  });

  it('refuses every name the framing cannot tell apart: NUL, a lone surrogate, non-ASCII, space, control, empty', async () => {
    // The two collisions the framing had with any name admitted. A NUL let one name absorb the
    // next module's frame: [x: '', y: 'code'] framed exactly as ['x' + 9 NUL + 'y': 'code'].
    await expect(
      storeDriverReleaseDigest({ entry: 'x\0\0\0\0\0\0\0\0\0y', modules: [{ name: 'x\0\0\0\0\0\0\0\0\0y', content: text('code') }] }),
    ).rejects.toThrow(/printable ASCII/);
    // And a lone surrogate encodes to U+FFFD's bytes, so these two names were one.
    for (const name of ['driver_a/\uD800.py', 'driver_a/�.py']) {
      await expect(storeDriverReleaseDigest({ entry: name, modules: [{ name, content: text('') }] })).rejects.toThrow(/printable ASCII/);
    }
    for (const name of ['driver_a/é.py', 'driver_a/a b.py', 'driver_a/a\tb.py', 'driver_a/\x7f.py', '']) {
      await expect(storeDriverReleaseDigest({ entry: name, modules: [{ name, content: text('') }] }), JSON.stringify(name)).rejects.toThrow(
        /printable ASCII/,
      );
    }
    // The entry is held to the rule as well as the modules.
    await expect(storeDriverReleaseDigest({ ...bundle, entry: 'driver_graph/store.py\0' })).rejects.toThrow(/printable ASCII/);
  });
});

describe('a store operation name is a fixed label (#2207 §6, #2245)', () => {
  it('refuses @, whitespace, : and a name past the cap', () => {
    for (const name of ['a:b', 'a b', 'a\tb', 'a@b', 'lookup:someone@example.com', 'x'.repeat(STORE_OPERATION_NAME_MAX + 1), '']) {
      expect(storeOperationName.safeParse(name).success, name).toBe(false);
      expect(storeRequest.safeParse({ operation: name }).success, name).toBe(false);
    }
  });

  it('accepts a label at the cap, and the reserved names', () => {
    for (const name of ['x'.repeat(STORE_OPERATION_NAME_MAX), 'increment', 'graph.query-v2', ...RESERVED_STORE_OPERATIONS]) {
      expect(storeOperationName.safeParse(name).success, name).toBe(true);
      expect(storeRequest.safeParse({ operation: name }).success, name).toBe(true);
    }
  });

  it('holds a driver registration\'s catalog to the same rule', () => {
    const registration = (operations: string[]) => ({
      driver: 'graph',
      releases: [{ sha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), schema: 0 }],
      className: 'GraphStore',
      operations,
      platformOperations: [...RESERVED_STORE_OPERATIONS],
    });
    expect(storeDriverRegistration.safeParse(registration(['increment'])).success).toBe(true);
    expect(storeDriverRegistration.safeParse(registration(['look:up'])).success).toBe(false);
  });
});

// #2242: subject erasure destroys the key once the stores answer, so "cannot tell" must
// never read as "holds none". The gate is the registry: no registered driver, no store.
describe('mayHoldScopeStores / scopeStoresDeclaredIn (#2242)', () => {
  const graph: StoreDriverRegistration = {
    driver: 'graph',
    releases: [{ sha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), schema: 0 }],
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
  const declaring = manifest([{ binding: 'GRAPH', driver: 'graph' }]);

  it('reads a manifest: declares, declares none, predates manifests, unreadable', () => {
    expect(scopeStoresDeclaredIn(declaring)).toBe(true);
    expect(scopeStoresDeclaredIn(manifest())).toBe(false);
    expect(scopeStoresDeclaredIn(null)).toBe(false);
    expect(scopeStoresDeclaredIn('{not json')).toBeUndefined();
    expect(scopeStoresDeclaredIn(JSON.stringify({ version: 1 }))).toBeUndefined();
  });

  it('with no driver registered nothing may hold a store, whatever the manifest says', () => {
    for (const json of [declaring, manifest(), null, undefined, '{not json']) {
      expect(mayHoldScopeStores(json, [])).toBe(false);
    }
  });

  it('the registered graph driver may hold a store a manifest declares, and not one that declares none', () => {
    expect(STORE_DRIVERS.map((driver) => driver.driver)).toEqual(['graph']);
    expect(mayHoldScopeStores(declaring)).toBe(true);
    expect(mayHoldScopeStores(undefined)).toBe(true);
    expect(mayHoldScopeStores('{not json')).toBe(true);
    expect(mayHoldScopeStores(manifest())).toBe(false);
    expect(mayHoldScopeStores(null)).toBe(false);
  });

  it('with a driver registered, unknown and unreadable count as may, and only a known "none" does not', () => {
    expect(mayHoldScopeStores(declaring, [graph])).toBe(true);
    expect(mayHoldScopeStores(undefined, [graph])).toBe(true);
    expect(mayHoldScopeStores('{not json', [graph])).toBe(true);
    expect(mayHoldScopeStores(JSON.stringify({ version: 1 }), [graph])).toBe(true);
    expect(mayHoldScopeStores(manifest(), [graph])).toBe(false);
    expect(mayHoldScopeStores(null, [graph])).toBe(false);
  });
});

describe('reserved store results are additive (#2239)', () => {
  it('a later field on any reserved result still parses', () => {
    expect(storeWipeResult.safeParse({ ok: true }).success).toBe(true);
    expect(storeSizeResult.safeParse({ bytes: 1, driver: 'graph' }).success).toBe(true);
    expect(storeEraseResult.safeParse({ erased: 0, note: 'x' }).success).toBe(true);
    expect(storeImportResult.safeParse({ tables: 1, took: 3 }).success).toBe(true);
    expect(storeExportResult.safeParse({ tables: [], at: 'now' }).success).toBe(true);
  });
});

// K-53's rename, on what a store's old spelling may already have reached: a dump and the admin log.
describe('the store driver rename, on the dump and the admin log', () => {
  const dump = { tenantId: 't', scopeId: 's', capturedAt: '2026-10-16T00:00:00.000Z', tables: [] };

  it('loads a dump from before scope stores, and one whose stores are empty, unchanged', () => {
    expect(scopeDump.parse(dump).stores).toEqual([]);
    expect(scopeDump.parse({ ...dump, stores: [] }).stores).toEqual([]);
  });

  it('refuses a dump store that still spells `kind`, naming the rename, and loads `driver`', () => {
    const old = scopeDump.safeParse({ ...dump, stores: [{ binding: 'GRAPH', kind: 'graph', tables: [] }] });
    expect(old.success).toBe(false);
    expect(old.error?.issues.map((i) => i.message)).toContain(SCOPE_STORE_DUMP_KIND_RENAMED);
    expect(scopeDump.parse({ ...dump, stores: [{ binding: 'GRAPH', driver: 'graph', tables: [] }] }).stores).toEqual([
      { binding: 'GRAPH', driver: 'graph', tables: [] },
    ]);
  });

  it('still reads an admin-log row written under a pre-rename action, and the new names', () => {
    for (const action of [...HISTORIC_ADMIN_ACTIONS, 'uploadStoreDriverRelease', 'rollOutStoreDriver', 'rollBackStoreDriver', 'rebuildStoreDriver']) {
      expect(adminAction.parse(action)).toBe(action);
    }
    expect(HISTORIC_ADMIN_ACTIONS).toEqual(['uploadStoreKindRelease', 'rollOutStoreKind', 'rollBackStoreKind']);
    // The next case along: a name that was never an action is still refused.
    expect(adminAction.safeParse('rollOutStoreKinds').success).toBe(false);
  });
});
