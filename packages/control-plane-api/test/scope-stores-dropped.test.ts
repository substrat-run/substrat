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
  type ScopeDump,
  type ScopeId,
  type StoreDriverRegistration,
} from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  DEV_ACTOR_HEADER,
  UNSAFE_devPlatformActorAuth,
  type PlatformScopeStores,
  type VerticalClient,
} from '../src/index.js';

/**
 * A binding a later version dropped (#2286, RFC scope-stores L17). Its objects keep their data,
 * and object names carry no version, so the lifecycle reaches every binding any version of the
 * vertical declared: wipe and erasure still reach the old object whatever moved the scope off
 * the version that declared it (a bind, a promote, a rollback, a serving re-upload). A dump stays
 * one its scope can restore: a dropped binding whose export is empty is left out, and one that
 * still holds rows refuses the export. Nothing but export depends on that.
 */
describe('a dropped scope-store binding stays reached (#2286)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const graph: StoreDriverRegistration = {
    driver: 'graph',
    releases: [{ sha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), schema: 0 }],
    className: 'GraphStore',
    operations: [],
    platformOperations: [...RESERVED_STORE_OPERATIONS],
  };
  const GRAPH = { binding: 'GRAPH', driver: 'graph' };
  const OLD = { binding: 'OLD', driver: 'graph' };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-dropped-store-'));
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
    await host.admin.createTenant(staff, { id: t, slug: 'dropped-co', name: 'Dropped Co' });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A vertical of its own: the union is the vertical's. */
  const vertical = async () => {
    const slug = `drop-${ulid().toLowerCase().slice(-10)}`;
    await host.admin.registerVertical(staff, { slug, name: slug, source: 'cli' });
    const publish = async (scopeStores: { binding: string; driver: string }[]) => {
      const id = ulid();
      await host.admin.publishVersion(staff, {
        id,
        verticalSlug: slug,
        version: `1.0.${id.slice(-6).toLowerCase()}`,
        manifestDigest: `m-${id}`,
        permissionDigest: 'p',
        migrationDigest: 'g',
        deploymentRef: null,
        manifestJson: JSON.stringify({
          version: '1.0.0', entry: 'index.js', compatibilityDate: '2026-07-01',
          registry: { permissions: [], roles: [], entityGrants: [] },
          digests: { manifest: 'm', permission: 'p', migration: 'g' },
          scopeStores,
        }),
      });
      await host.admin.admitVersion(staff, id);
      return id;
    };
    return { slug, publish };
  };

  /** An active scope of `slug` with one sealed payload, and a probe for whether its key survives. */
  const scopeOf = async (slug: string) => {
    const s = scopeId.parse(ulid());
    const subject = dataSubjectId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: slug });
    await host.admin.activateScope(staff, t, s);
    const [sealed] = await host.admin.sealSubjectPayloads(staff, t, s, [{ subjectId: subject, plaintext: 'pii' }]);
    const keyKept = async () =>
      (await host.admin.openSubjectPayloads(staff, t, s, [{ subjectId: subject, sealed: sealed! }]))[0] === 'pii';
    return { s, subject, keyKept };
  };

  /** Store objects as the platform's caller sees them: rows per (scope, binding), and what was asked. */
  const objects = () => {
    const rows = new Map<string, number>();
    const asked: string[] = [];
    const key = (s: string, binding: string) => `${s}/${binding}`;
    const caller: PlatformScopeStores = {
      exportStores: async ({ scopeId: s, stores }) => stores.map((store) => ({
        ...store,
        tables: [{ name: 'nodes', ddl: 'CREATE TABLE nodes (id TEXT)', columns: ['id'], rows: Array.from({ length: rows.get(key(s, store.binding)) ?? 0 }, (_, i) => [`n${i}`]) }],
      })),
      importStores: async ({ scopeId: s, stores }) => {
        for (const store of stores) rows.set(key(s, store.binding), store.tables.reduce((n, table) => n + table.rows.length, 0));
      },
      eraseSubject: async ({ stores }) => {
        asked.push(...stores.map((store) => `erase ${store.binding}`));
        return stores.map((store) => ({ binding: store.binding, erased: 0 }));
      },
      wipeStores: async ({ scopeId: s, stores }) => {
        asked.push(...stores.map((store) => `wipe ${store.binding}`));
        for (const store of stores) rows.delete(key(s, store.binding));
      },
      sizeStores: async ({ stores }) => stores.map((store) => ({ binding: store.binding, bytes: 0 })),
    };
    return { caller, asked, put: (s: ScopeId, binding: string, n: number) => rows.set(key(s, binding), n) };
  };

  /** The deployment a serving-pinned scope is erased and deleted through: it holds nothing of its own here. */
  const deployment = {
    redactSubject: async () => ({
      events: 0, intents: 0, jobRuns: 0, idempotencyResults: 0, intentIds: [],
      vertical: { verticalRows: [], hookRows: [], unreachedEntities: [] },
    }),
    deleteScope: async () => undefined,
  } as unknown as VerticalClient;

  const apiWith = (caller: PlatformScopeStores) => createControlPlaneApi({
    host,
    authenticate: UNSAFE_devPlatformActorAuth(),
    storeDrivers: [graph],
    platformScopeStores: caller,
    resolveVerticalRef: async () => deployment,
  });

  const erase = (api: ReturnType<typeof apiWith>, s: ScopeId, subject: string) =>
    api.request(`/tenants/${t}/scopes/${s}/subjects/${subject}/shred`, { method: 'POST', headers: auth });
  const reapWithoutBackup = async (api: ReturnType<typeof apiWith>, s: ScopeId) => {
    await host.admin.archiveScope(staff, t, s);
    return api.request(`/tenants/${t}/scopes/${s}/reap`, { method: 'POST', headers: auth, body: JSON.stringify({ backup: false }) });
  };

  describe('wipe and erasure reach the dropped binding, whatever moved the scope off it', () => {
    /** A scope that ran a version declaring GRAPH and OLD, then moved to one declaring GRAPH alone. */
    const movers: [string, () => Promise<{ s: ScopeId; subject: string; keyKept: () => Promise<boolean> }>][] = [
      ['a bind', async () => {
        const v = await vertical();
        const both = await v.publish([GRAPH, OLD]);
        const one = await v.publish([GRAPH]);
        const scope = await scopeOf(v.slug);
        await host.admin.bindScopeVersion(staff, t, scope.s, both);
        await host.admin.bindScopeVersion(staff, t, scope.s, one);
        return scope;
      }],
      ...(['a promote', 'a serving re-upload'] as const).map((what): [string, () => Promise<{ s: ScopeId; subject: string; keyKept: () => Promise<boolean> }>] => [what, async () => {
        // Both move the serving pointer onto another version under the same serving script.
        const v = await vertical();
        const both = await v.publish([GRAPH, OLD]);
        const one = await v.publish([GRAPH]);
        const scope = await scopeOf(v.slug);
        const ref = `${v.slug}-serving`;
        await host.admin.setVerticalServing(staff, v.slug, { ref, versionId: both, doClasses: ['ScopeDO'], migrationTag: 'v1' });
        await host.admin.setScopeServingRef(staff, t, scope.s, ref);
        await host.admin.setVerticalServing(staff, v.slug, { ref, versionId: one, doClasses: ['ScopeDO'], migrationTag: 'v2' });
        return scope;
      }]),
      ['a rollback', async () => {
        // The pointer goes back to an OLDER version, which never declared the binding the newer one added.
        const v = await vertical();
        const older = await v.publish([GRAPH]);
        const newer = await v.publish([GRAPH, OLD]);
        const scope = await scopeOf(v.slug);
        const ref = `${v.slug}-serving`;
        await host.admin.setVerticalServing(staff, v.slug, { ref, versionId: newer, doClasses: ['ScopeDO'], migrationTag: 'v2' });
        await host.admin.setScopeServingRef(staff, t, scope.s, ref);
        await host.admin.setVerticalServing(staff, v.slug, { ref, versionId: older, doClasses: ['ScopeDO'], migrationTag: 'v1' });
        return scope;
      }],
    ];

    for (const [what, moved] of movers) {
      it(`after ${what}: erasure erases OLD before the key goes, and the reap wipes it`, async () => {
        const { s, subject, keyKept } = await moved();
        const { caller, asked } = objects();
        const api = apiWith(caller);
        const erased = await erase(api, s, subject);
        expect(erased.status).toBe(200);
        expect(await keyKept()).toBe(false);
        expect(asked).toEqual(['erase GRAPH', 'erase OLD']);
        expect((await reapWithoutBackup(api, s)).status).toBe(200);
        expect(asked).toContain('wipe OLD');
      });
    }
  });

  describe('a dump stays restorable', () => {
    /** A scope bound to a version declaring GRAPH, after one that declared GRAPH and OLD. */
    const dropped = async () => {
      const v = await vertical();
      await v.publish([GRAPH, OLD]);
      const one = await v.publish([GRAPH]);
      const scope = await scopeOf(v.slug);
      await host.admin.bindScopeVersion(staff, t, scope.s, one);
      return { ...scope, slug: v.slug };
    };

    it('an empty dropped store is left out, and the full pull restores into its own scope', async () => {
      const { s, slug } = await dropped();
      const store = objects();
      store.put(s, 'GRAPH', 2);
      // A hosted scope: its own tables live in its deployment, its stores behind the platform.
      const hosted = {
        exportScope: async () => (await host.admin.exportScope(staff, t, s)).tables,
        restoreScope: async () => ({ tables: 0 }),
      } as unknown as VerticalClient;
      const api = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        storeDrivers: [graph],
        platformScopeStores: store.caller,
        verticals: { [slug]: hosted },
      });
      const pull = await api.request(`/tenants/${t}/scopes/${s}/export?full=true`, { headers: auth });
      expect(pull.status).toBe(200);
      const dump = (await pull.json()) as ScopeDump;
      expect(dump.stores.map((entry) => entry.binding)).toEqual(['GRAPH']);
      store.put(s, 'GRAPH', 0);
      const restored = await api.request(`/tenants/${t}/scopes/${s}/restore`, { method: 'POST', headers: auth, body: JSON.stringify(dump) });
      expect(restored.status).toBe(200);
      // GRAPH came back through the platform, rows and all.
      const again = (await (await api.request(`/tenants/${t}/scopes/${s}/export?full=true`, { headers: auth })).json()) as ScopeDump;
      expect(again.stores.map((entry) => [entry.binding, entry.tables[0]!.rows.length])).toEqual([['GRAPH', 2]]);
    });

    it('a dropped store that holds rows refuses the export (409) and names the way out; nothing else depends on export', async () => {
      const { s, subject, keyKept } = await dropped();
      const store = objects();
      store.put(s, 'OLD', 3);
      const api = apiWith(store.caller);
      const pull = await api.request(`/tenants/${t}/scopes/${s}/export?full=true`, { headers: auth });
      expect(pull.status).toBe(409);
      const { error } = (await pull.json()) as { error: string };
      expect(error).toContain("'OLD'");
      expect(error).toContain('Declare');
      // Erasure, and a reap that takes no backup, never export: they reach OLD regardless.
      expect((await erase(api, s, subject)).status).toBe(200);
      expect(await keyKept()).toBe(false);
      expect((await reapWithoutBackup(api, s)).status).toBe(200);
      expect(store.asked).toEqual(['erase GRAPH', 'erase OLD', 'wipe GRAPH', 'wipe OLD']);
    });
  });
});
