import { describe, expect, it } from 'vitest';
import { platformActorId, scopeId, substratError } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { runningVersionStoresOf, scopeStoresOf } from '../src/index.js';

/**
 * #2207: the control plane names a scope's stores from the version its deployment runs, by the
 * router's rule (`READ_ROUTE_SQL`): the vertical's serving version for a scope on the serving
 * pin, the bound version otherwise. Anything it cannot tell refuses once a kind is registered.
 */
describe('scopeStoresOf (#2207)', () => {
  const actor = platformActorId.parse(ulid());
  const id = scopeId.parse(ulid());
  const manifest = (scopeStores: unknown[]) => JSON.stringify({
    version: '1.0.0', entry: 'worker.js', compatibilityDate: '2025-01-01',
    digests: { manifest: 'm', permission: 'p', migration: 'g' }, scopeStores,
  });
  const GRAPH = [{ binding: 'GRAPH', kind: 'graph' }];
  const kind = { kind: 'graph' } as never;
  const registered = [kind];
  const admin = (manifests: Record<string, string | null>, serving: string | null | 'unknown-vertical') => ({
    verticalServing: async () => {
      if (serving === 'unknown-vertical') throw substratError('not_found', 'unknown vertical');
      return serving ? { ref: 'stable', versionId: serving, doClasses: [], migrationTag: 't' } : null;
    },
    versionManifest: async (_a: unknown, _v: string, versionId: string) => manifests[versionId] ?? null,
    // The host's record of every binding any version declared, refusing as it does: a manifest
    // that does not read, or a binding re-kinded among versions stored before publish refused it.
    verticalScopeStores: async () => {
      const union = new Map<string, string>();
      for (const json of Object.values(manifests)) {
        if (json === null) continue;
        let stores: { binding: string; kind: string }[];
        try {
          stores = (JSON.parse(json) as { scopeStores?: { binding: string; kind: string }[] }).scopeStores ?? [];
        } catch {
          throw substratError('unavailable', 'a manifest cannot be read');
        }
        for (const { binding, kind } of stores) {
          if ((union.get(binding) ?? kind) !== kind) throw substratError('unavailable', 're-kinded');
          union.set(binding, kind);
        }
      }
      return [...union].map(([binding, kind]) => ({ binding, kind }));
    },
  });
  const ask = (a: ReturnType<typeof admin>, scope: { servingRef: string | null; verticalVersionId: string | null }, kinds: never[] = registered) =>
    scopeStoresOf(a, actor, { id, vertical: 'docs', ...scope }, kinds);

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
    expect(await scopeStoresOf(admin({}, null), actor, { id, vertical: null, servingRef: null, verticalVersionId: null }, [kind])).toEqual([]);
  });

  it('with no kind registered nothing can hold a store, whatever a manifest declares (#2242)', async () => {
    expect(await ask(admin({ served: manifest(GRAPH) }, 'served'), { servingRef: 'stable', verticalVersionId: null }, [])).toEqual([]);
  });

  it('a version that declares none, or predates manifests, has none', async () => {
    expect(await ask(admin({ bound: manifest([]) }, null), { servingRef: null, verticalVersionId: 'bound' })).toEqual([]);
    expect(await ask(admin({ bound: null }, null), { servingRef: null, verticalVersionId: 'bound' })).toEqual([]);
  });

  for (const [what, a, scope] of [
    ['no version at all', admin({}, null), { servingRef: null, verticalVersionId: null }],
    ['a serving pin with nothing served', admin({}, null), { servingRef: 'stable', verticalVersionId: null }],
    ['a vertical the registry does not know', admin({}, 'unknown-vertical'), { servingRef: 'stable', verticalVersionId: null }],
    ['a pin naming another script than the serving pointer', admin({ served: manifest(GRAPH) }, 'served'), { servingRef: 'older-script', verticalVersionId: null }],
    ['a manifest that does not read', admin({ bound: '{nope' }, null), { servingRef: null, verticalVersionId: 'bound' }],
  ] as const) {
    it(`${what}: refuses (503) once a kind is registered, and is none while none is`, async () => {
      const refusal = await ask(a, scope).then(() => undefined, (e: unknown) => e);
      expect((refusal as { status?: number } | undefined)?.status).toBe(503);
      expect(await ask(a, scope, [])).toEqual([]);
    });
  }

  it('the same binding declared as two kinds refuses (#2286)', async () => {
    const a = admin({
      served: manifest(GRAPH),
      older: manifest([{ binding: 'GRAPH', kind: 'counter' }]),
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
