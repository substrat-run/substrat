import { describe, expect, it } from 'vitest';
import { platformActorId, scopeId, substratError } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { runningVersionStoresOf, scopeStoresOf } from '../src/index.js';

/**
 * #2207: the control plane names a scope's stores from the version its deployment runs, by the
 * router's rule (`READ_ROUTE_SQL`): the vertical's serving version for a scope on the serving
 * pin, the bound version otherwise. Anything it cannot tell refuses once a driver is registered,
 * unless no version of the vertical ever declared a store (#2394).
 */
describe('scopeStoresOf (#2207)', () => {
  const actor = platformActorId.parse(ulid());
  const id = scopeId.parse(ulid());
  const manifest = (scopeStores: unknown[]) => JSON.stringify({
    version: '1.0.0', entry: 'worker.js', compatibilityDate: '2025-01-01',
    digests: { manifest: 'm', permission: 'p', migration: 'g' }, scopeStores,
  });
  const GRAPH = [{ binding: 'GRAPH', driver: 'graph' }];
  const driver = { driver: 'graph' } as never;
  const registered = [driver];
  const admin = (manifests: Record<string, string | null>, serving: string | null | 'unknown-vertical') => ({
    verticalServing: async () => {
      if (serving === 'unknown-vertical') throw substratError('not_found', 'unknown vertical');
      return serving ? { ref: 'stable', versionId: serving, doClasses: [], migrationTag: 't' } : null;
    },
    versionManifest: async (_a: unknown, _v: string, versionId: string) => manifests[versionId] ?? null,
    // The host's record of every binding any version declared, refusing as it does: a manifest
    // that does not read, or a binding moved to another driver among versions stored before publish refused it.
    verticalScopeStores: async () => {
      const union = new Map<string, string>();
      for (const json of Object.values(manifests)) {
        if (json === null) continue;
        let stores: { binding: string; driver: string }[];
        try {
          stores = (JSON.parse(json) as { scopeStores?: { binding: string; driver: string }[] }).scopeStores ?? [];
        } catch {
          throw substratError('unavailable', 'a manifest cannot be read');
        }
        for (const { binding, driver } of stores) {
          if ((union.get(binding) ?? driver) !== driver) throw substratError('unavailable', 'moved to another driver');
          union.set(binding, driver);
        }
      }
      return [...union].map(([binding, driver]) => ({ binding, driver }));
    },
  });
  const ask = (a: ReturnType<typeof admin>, scope: { servingRef: string | null; verticalVersionId: string | null }, drivers: never[] = registered) =>
    scopeStoresOf(a, actor, { id, vertical: 'docs', ...scope }, drivers);

  it("a scope on the serving pin reads the serving version, not its (absent) bound one", async () => {
    expect(await ask(admin({ served: manifest(GRAPH) }, 'served'), { servingRef: 'stable', verticalVersionId: null })).toEqual(GRAPH);
  });

  it('a scope on the serving pin ignores a bound version that says otherwise, as the router does', async () => {
    expect(await ask(admin({ served: manifest(GRAPH), bound: manifest([]) }, 'served'), { servingRef: 'stable', verticalVersionId: 'bound' })).toEqual(GRAPH);
  });

  it('a scope off the pin still reaches a store only an older version declared (#2286)', async () => {
    const a = admin({ served: manifest(GRAPH), bound: manifest([]) }, 'served');
    const scope = { servingRef: null, verticalVersionId: 'bound' as string | null };
    expect(await ask(a, scope)).toEqual(GRAPH);
    expect(await runningVersionStoresOf(a, actor, { id, vertical: 'docs', ...scope }, registered)).toEqual([]);
  });

  it('a scope with no vertical has no store, and nothing is read', async () => {
    expect(await scopeStoresOf(admin({}, null), actor, { id, vertical: null, servingRef: null, verticalVersionId: null }, [driver])).toEqual([]);
  });

  it('with no driver registered nothing can hold a store, whatever a manifest declares (#2242)', async () => {
    expect(await ask(admin({ served: manifest(GRAPH) }, 'served'), { servingRef: 'stable', verticalVersionId: null }, [])).toEqual([]);
  });

  it('a version that declares none, or predates manifests, has none', async () => {
    expect(await ask(admin({ bound: manifest([]) }, null), { servingRef: null, verticalVersionId: 'bound' })).toEqual([]);
    expect(await ask(admin({ bound: null }, null), { servingRef: null, verticalVersionId: 'bound' })).toEqual([]);
  });

  // A running version that cannot be named or read, in a vertical a version of which declared a
  // store (`older`, which no scope runs): that store may exist, so it refuses.
  for (const [what, a, scope] of [
    ['no version at all', admin({ older: manifest(GRAPH) }, null), { servingRef: null, verticalVersionId: null }],
    ['a serving pin with nothing served', admin({ older: manifest(GRAPH) }, null), { servingRef: 'stable', verticalVersionId: null }],
    ['a serving pointer that cannot be read', admin({ older: manifest(GRAPH) }, 'unknown-vertical'), { servingRef: 'stable', verticalVersionId: null }],
    ['a pin naming another script than the serving pointer', admin({ served: manifest(GRAPH) }, 'served'), { servingRef: 'older-script', verticalVersionId: null }],
    ['a manifest that does not read', admin({ bound: '{nope' }, null), { servingRef: null, verticalVersionId: 'bound' }],
  ] as const) {
    it(`${what}: refuses (503) once a driver is registered, and is none while none is`, async () => {
      const refusal = await ask(a, scope).then(() => undefined, (e: unknown) => e);
      expect((refusal as { status?: number } | undefined)?.status).toBe(503);
      expect(await ask(a, scope, [])).toEqual([]);
    });
  }

  // The same running versions in a vertical no version of which declared a store (#2394): a store
  // can exist only under a binding a version declared, so there is none to reach, and none is
  // answered rather than refusing every lifecycle call of that vertical.
  for (const [what, a, scope] of [
    ['no version at all', admin({}, null), { servingRef: null, verticalVersionId: null }],
    ['a serving pin with nothing served', admin({}, null), { servingRef: 'stable', verticalVersionId: null }],
    ['a pin naming another script than the serving pointer', admin({ served: manifest([]) }, 'served'), { servingRef: 'older-script', verticalVersionId: null }],
  ] as const) {
    it(`${what}, in a vertical that never declared a store: none, with or without a driver registered`, async () => {
      expect(await ask(a, scope)).toEqual([]);
      expect(await runningVersionStoresOf(a, actor, { id, vertical: 'docs', ...scope }, registered)).toEqual([]);
      expect(await ask(a, scope, [])).toEqual([]);
    });
  }

  // The sweep resolves this for nearly every scope it meters or reaps (#2394): a vertical that never
  // declared a store costs the one read of its record, and nothing else is read, under the hosted registry.
  it('a vertical that never declared a store costs one directory read, the record, under the default registry', async () => {
    /** `a`, recording each directory read it answers. */
    const counting = (a: ReturnType<typeof admin>) => {
      const reads: string[] = [];
      const spy = {
        verticalServing: async (...args: Parameters<typeof a.verticalServing>) => (reads.push('verticalServing'), a.verticalServing(...args)),
        versionManifest: async (...args: Parameters<typeof a.versionManifest>) => (reads.push('versionManifest'), a.versionManifest(...args)),
        verticalScopeStores: async () => (reads.push('verticalScopeStores'), a.verticalScopeStores()),
      };
      return { spy, reads };
    };
    const none = counting(admin({ served: manifest([]), bound: manifest([]) }, 'served'));
    for (const scope of [
      { servingRef: 'stable', verticalVersionId: null },
      { servingRef: 'older-script', verticalVersionId: null },
      { servingRef: null, verticalVersionId: 'bound' },
    ]) {
      for (const resolve of [scopeStoresOf, runningVersionStoresOf]) {
        none.reads.length = 0;
        expect(await resolve(none.spy, actor, { id, vertical: 'docs', ...scope })).toEqual([]);
        expect(none.reads).toEqual(['verticalScopeStores']);
      }
    }
    // The twin: once a version declared one, the record is read once, then the running version.
    const declaring = counting(admin({ served: manifest(GRAPH) }, 'served'));
    expect(await scopeStoresOf(declaring.spy, actor, { id, vertical: 'docs', servingRef: 'stable', verticalVersionId: null })).toEqual(GRAPH);
    expect(declaring.reads).toEqual(['verticalScopeStores', 'verticalServing', 'versionManifest']);
    // A running version that cannot be told there still refuses (503).
    const refusal = await scopeStoresOf(declaring.spy, actor, { id, vertical: 'docs', servingRef: 'older-script', verticalVersionId: null })
      .then(() => undefined, (e: unknown) => e);
    expect((refusal as { status?: number } | undefined)?.status).toBe(503);
  });

  it('a version unknown whose vertical’s declarations cannot be read refuses (503): only a record that reads as empty says none', async () => {
    const a = admin({ older: '{nope' }, null);
    const scope = { servingRef: null, verticalVersionId: null };
    const refusal = await ask(a, scope).then(() => undefined, (e: unknown) => e);
    expect((refusal as { status?: number } | undefined)?.status).toBe(503);
    // The running version's stores alone too: a restore judges a dump against them and nothing else.
    const running = await runningVersionStoresOf(a, actor, { id, vertical: 'docs', ...scope }, registered).then(() => undefined, (e: unknown) => e);
    expect((running as { status?: number } | undefined)?.status).toBe(503);
  });

  it('the same binding declared as two drivers refuses (#2286)', async () => {
    const a = admin({
      served: manifest(GRAPH),
      older: manifest([{ binding: 'GRAPH', driver: 'counter' }]),
    }, 'served');
    const refusal = await ask(a, { servingRef: 'stable', verticalVersionId: null }).then(() => undefined, (e: unknown) => e);
    expect((refusal as { status?: number } | undefined)?.status).toBe(503);
  });

  it('a historical manifest that does not read refuses (#2286)', async () => {
    const a = admin({ served: manifest(GRAPH), older: '{nope' }, 'served');
    const refusal = await ask(a, { servingRef: 'stable', verticalVersionId: null }).then(() => undefined, (e: unknown) => e);
    expect((refusal as { status?: number } | undefined)?.status).toBe(503);
  });
});
