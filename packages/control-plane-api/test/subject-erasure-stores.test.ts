import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, UNSAFE_allowAllChecker, webCryptoSecretBox, type ScopeStoreRunner } from '@substrat-run/kernel';
import {
  dataSubjectId,
  platformActorId,
  RESERVED_STORE_OPERATIONS,
  scopeId,
  tenantId,
  type ScopeId,
  type StoreKindRegistration,
  type SubjectShredReceipt,
} from '@substrat-run/contracts';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import {
  createControlPlaneApi,
  DEV_ACTOR_HEADER,
  unreachablePlatformScopeStores,
  UNSAFE_devPlatformActorAuth,
  type PlatformScopeStores,
  type VerticalClient,
} from '../src/index.js';

/**
 * Subject erasure and scope stores, failing closed (#2242).
 *
 * The control plane destroys the subject key once the scope's stores answer. It calls them
 * itself, signed, through the store script (#2207); the vertical is never asked. An empty
 * answer is therefore a claim that nothing is held, and the control plane must not make it
 * when it cannot tell: a version it cannot name refuses (503), since it cannot say which
 * bindings to erase. Every case below reads the key back after the request: kept
 * means a retry can still converge, destroyed means the erasure is final.
 *
 * Gated on the store-kind registry: with no kind registered no deployment can hold a store,
 * and erasure proceeds as it did before stores existed.
 */
describe('subject erasure reaches scope stores, failing closed (#2242)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const graph: StoreKindRegistration = {
    kind: 'graph',
    release: '0.0.0-test',
    className: 'GraphStore',
    operations: [],
    platformOperations: [...RESERVED_STORE_OPERATIONS],
  };
  const redactOnly = {
    redactSubject: async () => ({
      events: 0,
      intents: 0,
      jobRuns: 0,
      idempotencyResults: 0,
      intentIds: [],
      vertical: { verticalRows: [], hookRows: [], unreachedEntities: [] },
    }),
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-shred-stores-'));
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(5)) });
    await host.admin.createTenant(staff, { id: t, slug: 'stores-co', name: 'Stores Co' });
    await host.admin.registerVertical(staff, { slug: 'docs', name: 'docs', source: 'cli' });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A scope on vertical `docs` with one sealed payload, and a probe that reads whether its key survives. */
  const sealedScope = async (vertical = 'docs') => {
    const s = scopeId.parse(ulid());
    const subject = dataSubjectId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical });
    await host.admin.activateScope(staff, t, s);
    const [sealed] = await host.admin.sealSubjectPayloads(staff, t, s, [{ subjectId: subject, plaintext: 'pii' }]);
    const keyKept = async () =>
      (await host.admin.openSubjectPayloads(staff, t, s, [{ subjectId: subject, sealed: sealed! }]))[0] === 'pii';
    return { s, subject, keyKept };
  };

  /** A scope nothing routes and no slug resolves, reached only through a retained copy: no deployment to ask. */
  const unservedScope = async () => {
    const scope = await sealedScope();
    const ref = `docs-copy-${scope.s.toLowerCase()}`;
    const move = ulid();
    await host.admin.recordScopeScriptCopy(staff, t, scope.s, ref, move, { role: 'destination' });
    await host.admin.settleScopeScriptCopy(staff, t, scope.s, ref, move, 'retained');
    return { ...scope, ref };
  };

  /** The platform's store caller: records each erase, and fails while `fail()` says so. */
  const platformStores = (fail: () => boolean = () => false, erased = 1) => {
    const asked: string[] = [];
    const caller: PlatformScopeStores = {
      ...unreachablePlatformScopeStores(),
      eraseSubject: async ({ scopeId: scope, subjectId: who, stores }) => {
        asked.push(`${scope}/${who}`);
        if (fail()) throw new ControlPlaneError(503, 'store unavailable');
        return stores.map((store) => ({ binding: store.binding, erased }));
      },
    };
    return { caller, asked };
  };

  const shred = (api: ReturnType<typeof createControlPlaneApi>, s: ScopeId, subject: string) =>
    api.request(`/tenants/${t}/scopes/${s}/subjects/${subject}/shred`, { method: 'POST', headers: auth });

  const bySlug = (platformScopeStores: PlatformScopeStores, storeKinds?: readonly StoreKindRegistration[]) =>
    createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { docs: redactOnly as unknown as VerticalClient },
      resolveVerticalRef: async () => undefined,
      platformScopeStores,
      ...(storeKinds ? { storeKinds } : {}),
    });

  describe('no store kind registered: nothing can hold a store, erasure proceeds', () => {
    it('no store is asked, and the key is destroyed', async () => {
      const { s, subject, keyKept } = await sealedScope();
      const { caller, asked } = platformStores(() => {
        throw new Error('should not be asked');
      });
      const res = await shred(bySlug(caller), s, subject);
      expect(res.status).toBe(200);
      expect(((await res.json()) as SubjectShredReceipt).storeErasures).toEqual([]);
      expect(asked).toEqual([]);
      expect(await keyKept()).toBe(false);
    });

    it('a scope with no deployment to ask still erases, and the key is destroyed', async () => {
      const { s, subject, keyKept, ref } = await unservedScope();
      const api = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        resolveVerticalRef: async (r) => (r === ref ? (redactOnly as unknown as VerticalClient) : undefined),
        platformScopeStores: unreachablePlatformScopeStores(),
      });
      expect((await shred(api, s, subject)).status).toBe(200);
      expect(await keyKept()).toBe(false);
    });
    // Not asked is not "nothing held": a host whose stores sit with it erases them in the
    // finalize, as its direct shred does, so the orchestrated route must not hand it `[]`.
    it('behind the orchestrated route, a host with co-located stores still erases them', async () => {
      const ownDir = mkdtempSync(join(tmpdir(), 'cp-shred-colocated-'));
      const asked: string[] = [];
      const runner: ScopeStoreRunner = {
        kind: 'counter',
        async start() {},
        async stop() {},
        async invoke(_address, request) {
          if (request.operation === 'substrat.erase') {
            asked.push(String(Reflect.get(request.input as object, 'subjectId')));
            return { result: { erased: 1 } };
          }
          return { result: { bytes: 0 } };
        },
      };
      const own = new SqliteScopeHost({
        dir: ownDir,
        checker: UNSAFE_allowAllChecker,
        secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(6)),
        scopeStores: { runners: [{ binding: 'GRAPH', runner }] },
      });
      try {
        const tenant = tenantId.parse(ulid());
        const s = scopeId.parse(ulid());
        const subject = dataSubjectId.parse(ulid());
        await own.admin.createTenant(staff, { id: tenant, slug: `t-${tenant.toLowerCase()}`, name: 'T' });
        await own.provisionScope(staff, { tenantId: tenant, scopeId: s, vertical: 'docs' });
        await own.admin.activateScope(staff, tenant, s);
        const api = createControlPlaneApi({
          host: own,
          authenticate: UNSAFE_devPlatformActorAuth(),
          verticals: { docs: redactOnly as unknown as VerticalClient },
          resolveVerticalRef: async () => undefined,
        });
        const res = await api.request(`/tenants/${tenant}/scopes/${s}/subjects/${subject}/shred`, { method: 'POST', headers: auth });
        expect(res.status).toBe(200);
        expect(((await res.json()) as SubjectShredReceipt).storeErasures).toEqual([{ binding: 'GRAPH', erased: 1 }]);
        expect(asked).toEqual([subject]);
      } finally {
        await own.close();
        rmSync(ownDir, { recursive: true, force: true });
      }
    });
  });

  describe('a store kind registered: a deployment that may hold a store is asked, or the key is kept', () => {
    // Stricter than asking the vertical (#2207): with no version to read, the control plane
    // cannot say which bindings to erase, so it refuses rather than guess an empty list.
    it('a scope with no bound version and no pin is a version unknown: 503, and the key is kept', async () => {
      const { s, subject, keyKept } = await sealedScope();
      const { caller, asked } = platformStores();
      const res = await shred(bySlug(caller, [graph]), s, subject);
      expect(res.status).toBe(503);
      expect(asked).toEqual([]);
      expect(await keyKept()).toBe(true);
    });

    it('a scope with no deployment to ask stops the erasure with 503, and the key is kept', async () => {
      const { s, subject, keyKept, ref } = await unservedScope();
      const api = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        storeKinds: [graph],
        resolveVerticalRef: async (r) => (r === ref ? (redactOnly as unknown as VerticalClient) : undefined),
        platformScopeStores: unreachablePlatformScopeStores(),
      });
      const res = await shred(api, s, subject);
      expect(res.status).toBe(503);
      expect(await keyKept()).toBe(true);
    });

    describe('a bound version decides by its manifest', () => {
      const publish = async (scopeStores?: unknown[], slug = 'docs', deployed = true) => {
        const id = ulid();
        const ref = deployed ? `${slug}-${id.toLowerCase()}` : null;
        await host.admin.publishVersion(staff, {
          id,
          verticalSlug: slug,
          version: `1.0.${id.slice(-4).toLowerCase()}`,
          manifestDigest: `m-${id}`,
          permissionDigest: 'p',
          migrationDigest: 'g',
          deploymentRef: ref,
          manifestJson: JSON.stringify({
            version: '1.0.0',
            entry: 'index.js',
            compatibilityDate: '2026-07-01',
            registry: { permissions: [], roles: [], entityGrants: [] },
            digests: { manifest: 'm', permission: 'p', migration: 'g' },
            ...(scopeStores ? { scopeStores } : {}),
          }),
        });
        await host.admin.admitVersion(staff, id);
        return { id, ref };
      };
      const bound = async (scopeStores?: unknown[], platform = platformStores()) => {
        const scope = await sealedScope();
        const version = await publish(scopeStores);
        await host.admin.bindScopeVersion(staff, t, scope.s, version.id);
        const api = createControlPlaneApi({
          host,
          authenticate: UNSAFE_devPlatformActorAuth(),
          storeKinds: [graph],
          resolveVerticalRef: async (r) => (r === version.ref ? (redactOnly as unknown as VerticalClient) : undefined),
          platformScopeStores: platform.caller,
        });
        return { ...scope, api, asked: platform.asked };
      };

      it('a version that declares no store is not asked, and the key is destroyed', async () => {
        const { s, subject, keyKept, api, asked } = await bound();
        const res = await shred(api, s, subject);
        expect(res.status).toBe(200);
        expect(asked).toEqual([]);
        expect(await keyKept()).toBe(false);
      });

      // The serving script runs the serving pointer's version, not the scope's bound one, so
      // that manifest is the one read. A pointer naming another script is a version unknown.
      const onServingScript = async (opts: { boundStores?: unknown[]; servedStores?: unknown[]; pointerRef?: string }) => {
        // Its own vertical: a serving pointer is the vertical's, and would reroute later binds.
        const slug = `served-${ulid().toLowerCase().slice(-10)}`;
        await host.admin.registerVertical(staff, { slug, name: slug, source: 'cli' });
        const scope = await sealedScope(slug);
        const boundVersion = await publish(opts.boundStores, slug);
        const servedVersion = await publish(opts.servedStores, slug);
        await host.admin.bindScopeVersion(staff, t, scope.s, boundVersion.id);
        const servingRef = `${slug}-serving`;
        await host.admin.setVerticalServing(staff, slug, {
          ref: opts.pointerRef ?? servingRef,
          versionId: servedVersion.id,
          doClasses: ['ScopeDO'],
          migrationTag: 'v1',
        });
        await host.admin.setScopeServingRef(staff, t, scope.s, servingRef);
        const platform = platformStores();
        const api = createControlPlaneApi({
          host,
          authenticate: UNSAFE_devPlatformActorAuth(),
          storeKinds: [graph],
          resolveVerticalRef: async (r) => (r === servingRef ? (redactOnly as unknown as VerticalClient) : undefined),
          platformScopeStores: platform.caller,
        });
        const status = (await shred(api, scope.s, scope.subject)).status;
        return { status, asked: platform.asked, expected: [`${scope.s}/${scope.subject}`], keyKept: await scope.keyKept() };
      };
      const stores = [{ binding: 'GRAPH', kind: 'graph' }];

      it('on the serving script, the served version decides, not the bound one', async () => {
        const served = await onServingScript({ servedStores: stores });
        expect(served).toEqual({ status: 200, asked: served.expected, expected: served.expected, keyKept: false });
        const boundOnly = await onServingScript({ boundStores: stores });
        expect(boundOnly).toEqual({ status: 200, asked: [], expected: boundOnly.expected, keyKept: false });
      });

      // Stricter than asking (#2207): a version unknown names no binding to erase, so it refuses.
      it('on the serving script, a pointer naming another script is a version unknown: 503, and the key is kept', async () => {
        const other = await onServingScript({ pointerRef: 'docs-elsewhere' });
        expect(other).toEqual({ status: 503, asked: [], expected: other.expected, keyKept: true });
      });

      it('a store erase that fails stops the erasure before the key, and a retry then destroys it', async () => {
        let fail = true;
        const { s, subject, keyKept, api, asked } = await bound(stores, platformStores(() => fail, 0));
        const refused = await shred(api, s, subject);
        expect(refused.status).toBeGreaterThanOrEqual(500);
        expect(await keyKept()).toBe(true);
        // The retry: the store already erased what it held, and says so with a zero.
        fail = false;
        const retried = await shred(api, s, subject);
        expect(retried.status).toBe(200);
        expect(((await retried.json()) as SubjectShredReceipt).storeErasures).toEqual([{ binding: 'GRAPH', erased: 0 }]);
        expect(asked).toEqual([`${s}/${subject}`, `${s}/${subject}`]);
        expect(await keyKept()).toBe(false);
      });

      it('a version that declares a store, with no route to the store script, stops the erasure (503), and the key is kept', async () => {
        const { s, subject, keyKept, api } = await bound(stores, { caller: unreachablePlatformScopeStores(), asked: [] });
        expect((await shred(api, s, subject)).status).toBe(503);
        expect(await keyKept()).toBe(true);
      });

      it('a binding added while the stores are erased keeps the key (#2285)', async () => {
        const scope = await sealedScope();
        const version = await publish(stores);
        await host.admin.bindScopeVersion(staff, t, scope.s, version.id);
        const caller: PlatformScopeStores = {
          ...unreachablePlatformScopeStores(),
          eraseSubject: async () => {
            const added = await publish([{ binding: 'GRAPH', kind: 'graph' }, { binding: 'NOTES', kind: 'graph' }]);
            await host.admin.bindScopeVersion(staff, t, scope.s, added.id);
            return [{ binding: 'GRAPH', erased: 1 }];
          },
        };
        const api = createControlPlaneApi({
          host,
          authenticate: UNSAFE_devPlatformActorAuth(),
          storeKinds: [graph],
          resolveVerticalRef: async (r) => (r === version.ref ? (redactOnly as unknown as VerticalClient) : undefined),
          platformScopeStores: caller,
        });
        const res = await shred(api, scope.s, scope.subject);
        expect(res.status).toBe(412);
        expect(await scope.keyKept()).toBe(true);
      });

      /**
       * The direct arm (#2285): no script to redact through, so the host's own shred runs, and it
       * takes the same claim the orchestrated finalize takes. `move` runs while the stores are erased.
       */
      const direct = async (move: (s: ScopeId) => Promise<void>) => {
        const scope = await sealedScope();
        const version = await publish([{ binding: 'GRAPH', kind: 'graph' }], 'docs', false);
        await host.admin.bindScopeVersion(staff, t, scope.s, version.id);
        const caller: PlatformScopeStores = {
          ...unreachablePlatformScopeStores(),
          eraseSubject: async ({ stores }) => {
            await move(scope.s);
            return stores.map((store) => ({ binding: store.binding, erased: 1 }));
          },
        };
        const api = createControlPlaneApi({
          host,
          authenticate: UNSAFE_devPlatformActorAuth(),
          storeKinds: [graph],
          platformScopeStores: caller,
        });
        return { ...scope, res: await shred(api, scope.s, scope.subject) };
      };

      it('on the direct arm, a bind that adds a binding while the stores are erased keeps the key (#2285)', async () => {
        const { res, keyKept } = await direct(async (s) => {
          const added = await publish([{ binding: 'GRAPH', kind: 'graph' }, { binding: 'NOTES', kind: 'graph' }], 'docs', false);
          await host.admin.bindScopeVersion(staff, t, s, added.id);
        });
        expect(res.status).toBe(412);
        expect(await keyKept()).toBe(true);
      });

      it('on the direct arm, an erasure nothing moved under destroys the key, and moves the epoch a bind compares', async () => {
        const { s, res, keyKept } = await direct(async () => undefined);
        expect(res.status).toBe(200);
        expect(await keyKept()).toBe(false);
        expect(await host.admin.scopeErasureEpoch(staff, t, s)).toBe(1);
      });

      it('a promote onto the same serving script that adds a binding keeps the key (#2285)', async () => {
        const slug = `moved-${ulid().toLowerCase().slice(-10)}`;
        await host.admin.registerVertical(staff, { slug, name: slug, source: 'cli' });
        const scope = await sealedScope(slug);
        const served = await publish(stores, slug);
        const servingRef = `${slug}-serving`;
        await host.admin.bindScopeVersion(staff, t, scope.s, served.id);
        await host.admin.setVerticalServing(staff, slug, {
          ref: servingRef, versionId: served.id, doClasses: ['ScopeDO'], migrationTag: 'v1',
        });
        await host.admin.setScopeServingRef(staff, t, scope.s, servingRef);
        const caller: PlatformScopeStores = {
          ...unreachablePlatformScopeStores(),
          eraseSubject: async () => {
            const next = await publish([{ binding: 'GRAPH', kind: 'graph' }, { binding: 'NOTES', kind: 'graph' }], slug);
            await host.admin.setVerticalServing(staff, slug, {
              ref: servingRef, versionId: next.id, doClasses: ['ScopeDO'], migrationTag: 'v1',
            });
            return [{ binding: 'GRAPH', erased: 1 }];
          },
        };
        const api = createControlPlaneApi({
          host,
          authenticate: UNSAFE_devPlatformActorAuth(),
          storeKinds: [graph],
          resolveVerticalRef: async (r) => (r === servingRef ? (redactOnly as unknown as VerticalClient) : undefined),
          platformScopeStores: caller,
        });
        const res = await shred(api, scope.s, scope.subject);
        expect(res.status).toBe(412);
        expect(await scope.keyKept()).toBe(true);
      });

      it('a version that declares a store is asked', async () => {
        const { s, subject, keyKept, api, asked } = await bound([{ binding: 'GRAPH', kind: 'graph' }]);
        const res = await shred(api, s, subject);
        expect(res.status).toBe(200);
        expect(asked).toEqual([`${s}/${subject}`]);
        expect(((await res.json()) as SubjectShredReceipt).storeErasures).toEqual([{ binding: 'GRAPH', erased: 1 }]);
        expect(await keyKept()).toBe(false);
      });
    });
  });
});
