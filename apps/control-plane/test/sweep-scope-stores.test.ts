import { describe, expect, it } from 'vitest';
import { scopeId, tenantId, type Scope } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { declaredStoreSizes, wipeDeclaredScopeStores } from '../src/worker.js';

/**
 * #2207: the sweep's reap wipe and storage gauge name a scope's stores from the version its
 * deployment runs (`scopeStoresOf`), as the router does. An install on the serving pin has no
 * bound version; reading only the bound one skipped its store. Anything that cannot be told, or
 * no route to the stores, refuses (503) instead of skipping.
 */
describe('the sweep reaches a serving-pinned store, and never skips one silently (#2207)', () => {
  const driver = { driver: 'graph' } as never;
  const manifest = JSON.stringify({
    version: '1.0.0', entry: 'worker.js', compatibilityDate: '2025-01-01',
    digests: { manifest: 'm', permission: 'p', migration: 'g' },
    scopeStores: [{ binding: 'GRAPH', driver: 'graph' }],
  });
  const scope = (servingRef: string | null): Scope => ({
    id: scopeId.parse(ulid()), tenantId: tenantId.parse(ulid()), vertical: 'graphy',
    servingRef, verticalVersionId: null,
  }) as unknown as Scope;
  const admin = {
    verticalServing: async () => ({ ref: 'graphy-stable', versionId: 'served', doClasses: [], migrationTag: 't' }),
    versionManifest: async () => manifest,
    verticalScopeStores: async () => [{ binding: 'GRAPH', driver: 'graph' }],
  };
  const status = (e: unknown) => (e as { status?: number } | undefined)?.status;
  const refusal = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

  it('a serving-pinned install with a store is not skipped: with no route to the stores, the wipe and the gauge refuse', async () => {
    // `undefined` is the hosted registry, `STORE_DRIVERS`, which holds graph.
    for (const drivers of [[driver], undefined]) {
      expect(status(await refusal(wipeDeclaredScopeStores({}, admin, scope('graphy-stable'), drivers)))).toBe(503);
      expect(status(await refusal(declaredStoreSizes({}, admin, scope('graphy-stable'), drivers)))).toBe(503);
    }
  });

  it('with a route, a serving-pinned install is wiped and sized through its store script', async () => {
    const asked: string[] = [];
    const routed = {
      // The shared vector's PKCS8 key (packages/contracts/test/vectors/scope-store-envelope.json).
      STORE_PLATFORM_KEY: 'MC4CAQAwBQYDK2VwBCIEIOPA7a30FgDjM6aB-oV3_tRs_eDbRaDFHMxNOY5aAiZJ',
      DISPATCH: {
        get: (script: string) => ({
          fetch: async (request: Request) => {
            const { operation } = (await request.json()) as { operation: string };
            asked.push(`${script} ${operation}`);
            return Response.json({ result: operation === 'substrat.size' ? { bytes: 7 } : {} });
          },
        }),
      },
    } as never;
    await wipeDeclaredScopeStores(routed, admin, scope('graphy-stable'), [driver]);
    expect(await declaredStoreSizes(routed, admin, scope('graphy-stable'), [driver])).toEqual([{ binding: 'GRAPH', bytes: 7 }]);
    expect(asked.map((a) => a.split(' ')[1])).toEqual(['substrat.wipe', 'substrat.size']);
  });

  it('a scope whose version cannot be told refuses once a driver is registered', async () => {
    for (const s of [scope(null), scope('graphy-older')]) {
      expect(status(await refusal(wipeDeclaredScopeStores({}, admin, s, [driver])))).toBe(503);
      expect(status(await refusal(declaredStoreSizes({}, admin, s, [driver])))).toBe(503);
    }
  });

  it('with no driver registered nothing can hold a store, and both proceed as before', async () => {
    await expect(wipeDeclaredScopeStores({}, admin, scope('graphy-stable'), [])).resolves.toBeUndefined();
    await expect(declaredStoreSizes({}, admin, scope(null), [])).resolves.toEqual([]);
  });
});
