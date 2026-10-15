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
  storeKindId,
  storeKindRegistration,
  storeKindReleaseDigest,
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
        releases: [{ sha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40) }],
        className: 'Store',
        operations: ['read'],
        platformOperations: reserved,
      }),
    ).toThrow(/substrat.erase/);
  });

  it('holds a kind id to [a-z0-9]+ (L20), at the registration and in every registered kind', () => {
    const registration = (kind: string) => ({
      kind,
      releases: [{ sha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40) }],
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
        releases: [{ sha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40) }],
        className: 'Store',
        operations: ['substrat.wipe'],
        platformOperations: [...RESERVED_STORE_OPERATIONS],
      }),
    ).toThrow(/substrat/);
  });
});

describe('a store kind release is pinned by sha256 and source commit (D-63)', () => {
  const registration = (releases: unknown) => ({
    kind: 'graph',
    releases,
    className: 'GraphStore',
    operations: [],
    platformOperations: [...RESERVED_STORE_OPERATIONS],
  });
  const pin = { sha256: 'c'.repeat(64), sourceCommit: 'd'.repeat(40) };

  it('admits a list of pins, and refuses an empty list, a repeated pin, and a malformed one', () => {
    expect(storeKindRegistration.safeParse(registration([pin, { ...pin, sha256: 'e'.repeat(64) }])).success).toBe(true);
    for (const releases of [
      [],
      [pin, { ...pin }],
      [{ ...pin, sha256: 'C'.repeat(64) }],
      [{ ...pin, sha256: 'c'.repeat(63) }],
      [{ ...pin, sourceCommit: 'd'.repeat(39) }],
      [{ sha256: pin.sha256 }],
      [{ ...pin, release: '1.0.0' }],
      '1.0.0',
    ]) {
      expect(storeKindRegistration.safeParse(registration(releases)).success, JSON.stringify(releases)).toBe(false);
    }
    // The registration that named a release by label is no longer one.
    expect(storeKindRegistration.safeParse({ ...registration([pin]), releases: undefined, release: '1.0.0' }).success).toBe(false);
  });

  const text = (value: string) => new TextEncoder().encode(value);
  const modules = [
    { name: 'kind_graph/store.py', content: text('class GraphStore:\n    pass\n') },
    { name: 'kind_graph/__init__.py', content: new Uint8Array() },
  ];
  const bundle = { entry: 'kind_graph/store.py', modules };

  it('digests a release to a fixed vector, computed outside this code', async () => {
    // printf 'substrat.store-release/v1\000' 'kind_graph/store.py\000', then the modules in name
    // order: 'kind_graph/__init__.py\000' + 8 zero bytes, 'kind_graph/store.py\000' + 7 zero
    // bytes + '\033' + the 27 bytes of the module, piped to `shasum -a 256`.
    expect(await storeKindReleaseDigest(bundle)).toBe('99b9a70c48f2304ed01034abc9b70e9661231a4e89a26e2bad49074afb6f933f');
  });

  it('is the same digest in any order, and another for any other bytes, name, split or entry', async () => {
    const digest = await storeKindReleaseDigest(bundle);
    expect(await storeKindReleaseDigest({ ...bundle, modules: [...modules].reverse() })).toBe(digest);
    const others = [
      { ...bundle, modules: [modules[0]!, { ...modules[1]!, content: text(' ') }] },
      { entry: 'kind_graph/graph.py', modules: [{ ...modules[0]!, name: 'kind_graph/graph.py' }, modules[1]!] },
      { ...bundle, modules: [modules[0]!] },
      // The same modules, with the entry importing another one: another release (D-63).
      { ...bundle, entry: 'kind_graph/__init__.py' },
      // The same bytes split differently between two names.
      { entry: 'a', modules: [{ name: 'a', content: text('bc') }, { name: 'b', content: text('') }] },
    ];
    const seen = new Set([
      digest,
      await storeKindReleaseDigest({ entry: 'a', modules: [{ name: 'a', content: text('b') }, { name: 'b', content: text('c') }] }),
    ]);
    for (const release of others) {
      const other = await storeKindReleaseDigest(release);
      expect(seen.has(other), JSON.stringify([release.entry, release.modules.map((m) => m.name)])).toBe(false);
      seen.add(other);
    }
  });

  it('refuses a release that names a module twice, or whose entry is not one of its modules', async () => {
    await expect(storeKindReleaseDigest({ ...bundle, modules: [modules[0]!, modules[0]!] })).rejects.toThrow(/twice/);
    await expect(storeKindReleaseDigest({ ...bundle, entry: 'kind_graph/legacy.py' })).rejects.toThrow(/not one of its modules/);
  });

  it('refuses every name the framing cannot tell apart: NUL, a lone surrogate, non-ASCII, space, control, empty', async () => {
    // The two collisions the framing had with any name admitted. A NUL let one name absorb the
    // next module's frame: [x: '', y: 'code'] framed exactly as ['x' + 9 NUL + 'y': 'code'].
    await expect(
      storeKindReleaseDigest({ entry: 'x\0\0\0\0\0\0\0\0\0y', modules: [{ name: 'x\0\0\0\0\0\0\0\0\0y', content: text('code') }] }),
    ).rejects.toThrow(/printable ASCII/);
    // And a lone surrogate encodes to U+FFFD's bytes, so these two names were one.
    for (const name of ['kind_a/\uD800.py', 'kind_a/�.py']) {
      await expect(storeKindReleaseDigest({ entry: name, modules: [{ name, content: text('') }] })).rejects.toThrow(/printable ASCII/);
    }
    for (const name of ['kind_a/é.py', 'kind_a/a b.py', 'kind_a/a\tb.py', 'kind_a/\x7f.py', '']) {
      await expect(storeKindReleaseDigest({ entry: name, modules: [{ name, content: text('') }] }), JSON.stringify(name)).rejects.toThrow(
        /printable ASCII/,
      );
    }
    // The entry is held to the rule as well as the modules.
    await expect(storeKindReleaseDigest({ ...bundle, entry: 'kind_graph/store.py\0' })).rejects.toThrow(/printable ASCII/);
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

  it('holds a kind registration\'s catalog to the same rule', () => {
    const registration = (operations: string[]) => ({
      kind: 'graph',
      releases: [{ sha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40) }],
      className: 'GraphStore',
      operations,
      platformOperations: [...RESERVED_STORE_OPERATIONS],
    });
    expect(storeKindRegistration.safeParse(registration(['increment'])).success).toBe(true);
    expect(storeKindRegistration.safeParse(registration(['look:up'])).success).toBe(false);
  });
});

// #2242: subject erasure destroys the key once the stores answer, so "cannot tell" must
// never read as "holds none". The gate is the registry: no registered kind, no store.
describe('mayHoldScopeStores / scopeStoresDeclaredIn (#2242)', () => {
  const graph: StoreKindRegistration = {
    kind: 'graph',
    releases: [{ sha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40) }],
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

describe('reserved store results are additive (#2239)', () => {
  it('a later field on any reserved result still parses', () => {
    expect(storeWipeResult.safeParse({ ok: true }).success).toBe(true);
    expect(storeSizeResult.safeParse({ bytes: 1, kind: 'graph' }).success).toBe(true);
    expect(storeEraseResult.safeParse({ erased: 0, note: 'x' }).success).toBe(true);
    expect(storeImportResult.safeParse({ tables: 1, took: 3 }).success).toBe(true);
    expect(storeExportResult.safeParse({ tables: [], at: 'now' }).success).toBe(true);
  });
});
