import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
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
import { createControlPlaneApi, DEV_ACTOR_HEADER, UNSAFE_devPlatformActorAuth, type VerticalClient } from '../src/index.js';

/**
 * Subject erasure and scope stores, failing closed (#2242).
 *
 * The control plane destroys the subject key once the serving deployment's stores answer.
 * An empty answer is therefore a claim that nothing is held, and the control plane must not
 * make it when it cannot tell. Every case below reads the key back after the request: kept
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
    script: 'store-graph',
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
  const sealedScope = async () => {
    const s = scopeId.parse(ulid());
    const subject = dataSubjectId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
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

  const shred = (api: ReturnType<typeof createControlPlaneApi>, s: ScopeId, subject: string) =>
    api.request(`/tenants/${t}/scopes/${s}/subjects/${subject}/shred`, { method: 'POST', headers: auth });

  const bySlug = (docs: object, storeKinds?: readonly StoreKindRegistration[]) =>
    createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { docs: { ...redactOnly, ...docs } as unknown as VerticalClient },
      // Without a ref resolver the route shreds on this host alone, never reaching a deployment.
      resolveVerticalRef: async () => undefined,
      ...(storeKinds ? { storeKinds } : {}),
    });

  describe('no store kind registered: nothing can hold a store, erasure proceeds', () => {
    it('a slug-rung deployment is not asked, and the key is destroyed', async () => {
      const { s, subject, keyKept } = await sealedScope();
      let asked = false;
      const api = bySlug({
        scopeStoreErase: async () => {
          asked = true;
          throw new Error('should not be asked');
        },
      });
      const res = await shred(api, s, subject);
      expect(res.status).toBe(200);
      expect(((await res.json()) as SubjectShredReceipt).storeErasures).toEqual([]);
      expect(asked).toBe(false);
      expect(await keyKept()).toBe(false);
    });

    it('a scope with no deployment to ask still erases, and the key is destroyed', async () => {
      const { s, subject, keyKept, ref } = await unservedScope();
      const api = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        resolveVerticalRef: async (r) => (r === ref ? (redactOnly as unknown as VerticalClient) : undefined),
      });
      expect((await shred(api, s, subject)).status).toBe(200);
      expect(await keyKept()).toBe(false);
    });
  });

  describe('a store kind registered: a deployment that may hold a store is asked, or the key is kept', () => {
    it('a slug-rung deployment (no bound version) is asked, and its list reaches the receipt', async () => {
      const { s, subject, keyKept } = await sealedScope();
      const asked: string[] = [];
      const api = bySlug(
        {
          scopeStoreErase: async (_t: string, scope: string, who: string) => {
            asked.push(`${scope}/${who}`);
            return [{ binding: 'GRAPH', erased: 2 }];
          },
        },
        [graph],
      );
      const res = await shred(api, s, subject);
      expect(res.status).toBe(200);
      expect(((await res.json()) as SubjectShredReceipt).storeErasures).toEqual([{ binding: 'GRAPH', erased: 2 }]);
      expect(asked).toEqual([`${s}/${subject}`]);
      expect(await keyKept()).toBe(false);
    });

    it('a store erase that fails stops the erasure before the key, and a retry then destroys it', async () => {
      const { s, subject, keyKept } = await sealedScope();
      let fail = true;
      const api = bySlug(
        {
          scopeStoreErase: async () => {
            if (fail) throw new ControlPlaneError(503, 'store unavailable');
            return [{ binding: 'GRAPH', erased: 0 }];
          },
        },
        [graph],
      );
      const refused = await shred(api, s, subject);
      expect(refused.status).toBeGreaterThanOrEqual(500);
      expect(await keyKept()).toBe(true);
      // The retry: the store already erased what it held, and says so with a zero.
      fail = false;
      const retried = await shred(api, s, subject);
      expect(retried.status).toBe(200);
      expect(((await retried.json()) as SubjectShredReceipt).storeErasures).toEqual([{ binding: 'GRAPH', erased: 0 }]);
      expect(await keyKept()).toBe(false);
    });

    it('a deployment that cannot be asked (no erase method) stops the erasure, and the key is kept', async () => {
      const { s, subject, keyKept } = await sealedScope();
      const res = await shred(bySlug({}, [graph]), s, subject);
      expect(res.status).toBe(502);
      expect(await keyKept()).toBe(true);
    });

    it('a scope with no deployment to ask stops the erasure with 502, and the key is kept', async () => {
      const { s, subject, keyKept, ref } = await unservedScope();
      const api = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        storeKinds: [graph],
        resolveVerticalRef: async (r) => (r === ref ? (redactOnly as unknown as VerticalClient) : undefined),
      });
      const res = await shred(api, s, subject);
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toMatch(/may hold a scope store/);
      expect(await keyKept()).toBe(true);
    });

    describe('a bound version decides by its manifest', () => {
      const publish = async (scopeStores?: unknown[]) => {
        const id = ulid();
        const ref = `docs-${id.toLowerCase()}`;
        await host.admin.publishVersion(staff, {
          id,
          verticalSlug: 'docs',
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
      const bound = async (scopeStores?: unknown[]) => {
        const scope = await sealedScope();
        const version = await publish(scopeStores);
        await host.admin.bindScopeVersion(staff, t, scope.s, version.id);
        let asked = false;
        const deployment = {
          ...redactOnly,
          scopeStoreErase: async () => {
            asked = true;
            return [{ binding: 'GRAPH', erased: 1 }];
          },
        } as unknown as VerticalClient;
        const api = createControlPlaneApi({
          host,
          authenticate: UNSAFE_devPlatformActorAuth(),
          storeKinds: [graph],
          resolveVerticalRef: async (r) => (r === version.ref ? deployment : undefined),
        });
        return { ...scope, api, wasAsked: () => asked };
      };

      it('a version that declares no store is not asked, and the key is destroyed', async () => {
        const { s, subject, keyKept, api, wasAsked } = await bound();
        const res = await shred(api, s, subject);
        expect(res.status).toBe(200);
        expect(wasAsked()).toBe(false);
        expect(await keyKept()).toBe(false);
      });

      it('a version that declares a store is asked', async () => {
        const { s, subject, keyKept, api, wasAsked } = await bound([{ binding: 'GRAPH', kind: 'graph' }]);
        const res = await shred(api, s, subject);
        expect(res.status).toBe(200);
        expect(wasAsked()).toBe(true);
        expect(((await res.json()) as SubjectShredReceipt).storeErasures).toEqual([{ binding: 'GRAPH', erased: 1 }]);
        expect(await keyKept()).toBe(false);
      });
    });
  });
});
