import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import {
  platformActorId,
  scopeId,
  tenantId,
  type ScopeBackup,
  type ScopeDump,
  type ScopeId,
  type StoreDriverRegistration,
} from '@substrat-run/contracts';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import {
  createControlPlaneApi,
  createR2BackupStore,
  DEV_ACTOR_HEADER,
  pruneScopeBackups,
  storeJobId,
  UNSAFE_devPlatformActorAuth,
  STORE_JOB_MAX_FAULTS,
  type StoreReadyWait,
  type StoreRequestBudget,
  type VerticalClient,
} from '../src/index.js';
import { memoryStoreJobs } from './helpers/memory-store-jobs.js';
import { fakeBucket, fakeStoreDriver, platformOver, storeObject } from './helpers/store-fakes.js';

/**
 * A store's backup, restore, snapshot and pull through the routes, on the pure host (D-69): pages as
 * objects of their own with an index written last, restored by staging first and committing after
 * the host's load, a large store handed to a job, and a body that refuses what it cannot carry.
 */
describe('a store is backed up and restored in pages, through the routes (D-69)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const graph: StoreDriverRegistration = { driver: 'graph', isolationBasis: { kind: 'writtenInRepo' }, dumpPageMaxBytes: 900_000 };
  const VERTICAL = 'pager';
  const roomy: StoreRequestBudget = { pages: 1000, ms: 60_000, sleep: async () => undefined };
  const tight: StoreRequestBudget = { ...roomy, pages: 2 };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-store-backup-'));
    host = new SqliteScopeHost({ dir });
    await host.admin.createTenant(staff, { id: t, slug: 'pager-co', name: 'Pager Co' });
    await host.admin.registerVertical(staff, { slug: VERTICAL, name: VERTICAL, source: 'cli' });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A version of the vertical declaring `bindings`, bound to `s`. */
  const bindVersion = async (s: ScopeId, bindings: readonly string[]): Promise<void> => {
    const id = ulid();
    await host.admin.publishVersion(staff, {
      id, verticalSlug: VERTICAL, version: `1.0.${id.toLowerCase()}`, manifestDigest: `m-${id}`, permissionDigest: 'p', migrationDigest: 'g',
      deploymentRef: `${VERTICAL}-${id.toLowerCase()}`,
      manifestJson: JSON.stringify({
        version: '1.0.0', entry: 'index.js', compatibilityDate: '2026-07-01',
        registry: { permissions: [], roles: [], entityGrants: [] },
        digests: { manifest: 'm', permission: 'p', migration: 'g' },
        scopeStores: bindings.map((binding) => ({ binding, driver: 'graph' })),
      }),
    });
    await host.admin.admitVersion(staff, id);
    await host.admin.bindScopeVersion(staff, t, s, id);
  };

  const graphScope = async (bindings: readonly string[] = ['GRAPH']): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: VERTICAL });
    await host.admin.activateScope(staff, t, s);
    await bindVersion(s, bindings);
    return s;
  };

  const reap = async (s: ScopeId) => {
    await host.admin.archiveScope(staff, t, s);
    await host.admin.reapScope(staff, t, s, { force: true });
  };

  const world = (opts: { budget?: StoreRequestBudget; jobs?: boolean; pullMax?: number; ready?: StoreReadyWait } = {}) => {
    const driver = fakeStoreDriver({ pageRows: 10 });
    const r2 = fakeBucket({ held: driver.held });
    const stores = platformOver(driver);
    const backups = createR2BackupStore(r2.bucket);
    /** What happened, in order: the store's stage and commit, the host's load, the deployment's. */
    const order: string[] = [];
    driver.intercept((call) => {
      if (call.operation === 'substrat.stage-page') order.push('stage');
      if (call.operation === 'substrat.commit-stage') order.push('commit');
      if (call.operation === 'substrat.erase') order.push('erase');
      return undefined;
    });
    const hooks = {
      hostLoad: async () => undefined as void,
      deploymentLoad: async () => undefined as void,
      shreddedRead: undefined as undefined | (() => Promise<never>),
    };
    const hostRestore = host.restoreScope.bind(host);
    const countingHost = new Proxy(host, {
      get(target, key, receiver) {
        if (key === 'restoreScope') {
          return (...args: Parameters<typeof hostRestore>) => {
            order.push('host-load');
            return hooks.hostLoad().then(() => hostRestore(...args));
          };
        }
        if (key === 'admin' && hooks.shreddedRead) {
          return new Proxy(target.admin, {
            get(admin, name, adminReceiver) {
              if (name === 'listShreddedSubjects') return hooks.shreddedRead;
              const member = Reflect.get(admin, name, adminReceiver) as unknown;
              return typeof member === 'function' ? (member as (...a: unknown[]) => unknown).bind(admin) : member;
            },
          });
        }
        const value = Reflect.get(target, key, receiver) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const deployment = {
      exportScope: async () => [{ name: 'notes', ddl: 'CREATE TABLE notes (id TEXT)', columns: ['id'], rows: [['own']] }],
      restoreScope: async () => {
        order.push('deployment-load');
        await hooks.deploymentLoad();
        return { tables: 1 };
      },
      snapshotScope: async () => ({ tables: 0 }),
      deleteScope: async () => undefined,
    } as unknown as VerticalClient;
    const jobs = opts.jobs ? memoryStoreJobs({ stores, backups, admin: host.admin }, { stepMs: 60_000 }) : undefined;
    const api = createControlPlaneApi({
      host: countingHost,
      authenticate: UNSAFE_devPlatformActorAuth(),
      storeDrivers: [graph],
      platformScopeStores: stores,
      scopeBackups: backups,
      verticals: { [VERTICAL]: deployment },
      storeRequestBudget: opts.budget ?? roomy,
      ...(jobs ? { storeJobs: jobs } : {}),
      ...(opts.pullMax !== undefined ? { storePullMaxBytes: opts.pullMax } : {}),
      ...(opts.ready ? { storeReadyWait: opts.ready } : {}),
    });
    const post = (path: string, body?: unknown) =>
      api.request(`/tenants/${t}${path}`, { method: 'POST', headers: auth, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const restoreOf = (s: ScopeId, capturedAt: string, sourceScopeId?: ScopeId) =>
      post(`/scopes/${s}/backups/restore`, { capturedAt, ...(sourceScopeId ? { sourceScopeId } : {}) });
    const parts = () => [...r2.objects.keys()];
    return {
      driver, r2, backups, order, hooks, api, post, jobs, restoreOf, parts,
      poll: (s: ScopeId, capturedAt: string) => post(`/scopes/${s}/backups?capturedAt=${encodeURIComponent(capturedAt)}`),
      object: (s: ScopeId, binding = 'GRAPH') => storeObject(t, VERTICAL, s, binding),
    };
  };

  /** A scope whose GRAPH holds `rows` rows, backed up in the request. */
  const backedUp = async (w: ReturnType<typeof world>, rows: number) => {
    const s = await graphScope();
    w.driver.put(w.object(s), rows);
    const res = await w.post(`/scopes/${s}/backups`);
    expect(res.status).toBe(201);
    return { s, backup: (await res.json()) as ScopeBackup };
  };

  it('a backup holds its pages as objects with an index, its dump carries no rows, and it restores whole', async () => {
    const w = world();
    const { s, backup } = await backedUp(w, 35);
    const prefix = `scopes/${t}/${s}/${backup.capturedAt}`;
    expect(w.parts().filter((key) => key.includes('/stores/'))).toHaveLength(4);
    expect(w.parts()).toContain(`${prefix}.json`);
    expect(w.parts().filter((key) => key.startsWith(`${prefix}/scope-`))).toHaveLength(1);
    expect(JSON.parse(w.r2.objects.get(`${prefix}.json`)!.body)).toMatchObject({
      form: 'paged',
      stores: [{ binding: 'GRAPH', driver: 'graph', pageCount: 4, tables: 1, revision: 'r2' }],
    });
    expect(backup.size).toBeGreaterThan(JSON.stringify({ rows: 35 }).length);

    const listed = (await (await w.api.request(`/tenants/${t}/scopes/${s}/backups`, { headers: auth })).json()) as ScopeBackup[];
    expect(listed.map((b) => [b.capturedAt, b.tables, b.size])).toEqual([[backup.capturedAt, backup.tables, backup.size]]);

    const read = (await (await w.api.request(`/tenants/${t}/scopes/${s}/backups/${backup.capturedAt}`, { headers: auth })).json()) as ScopeDump;
    expect(read.stores).toEqual([]);
    expect(read.storePages?.[0]?.pageCount).toBe(4);
    expect(read.tables.map((table) => table.name)).toEqual(['notes']);

    w.driver.put(w.object(s), 1);
    const restored = await w.restoreOf(s, backup.capturedAt);
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(w.driver.idsOf(w.object(s))).toHaveLength(35);
  });

  it('stages first, then the host load, the commit and the deployment load, in that order', async () => {
    const w = world();
    const { s, backup } = await backedUp(w, 15);
    const who = ulid();
    await host.admin.shredSubject(staff, t, s, who);
    w.order.length = 0;
    expect((await w.restoreOf(s, backup.capturedAt)).status).toBe(200);
    expect(w.order).toEqual(['stage', 'stage', 'host-load', 'commit', 'erase', 'deployment-load']);
  });

  it.each([
    ['a mangled page', (w: ReturnType<typeof world>, key: string) => { w.r2.objects.get(key)!.body = w.r2.objects.get(key)!.body.replace('n1', 'nX'); }],
    ['a missing page', (w: ReturnType<typeof world>, key: string) => { w.r2.objects.delete(key); }],
  ])('%s refuses before the commit, and before the load: nothing changed anywhere', async (_what, damage) => {
    const w = world();
    const { s, backup } = await backedUp(w, 25);
    w.driver.put(w.object(s), 1);
    const dump = (await w.backups.getIndex({ tenantId: t, scopeId: s, capturedAt: backup.capturedAt }))!;
    damage(w, dump.stores[0]!.pages[1]!.key);
    w.order.length = 0;
    const res = await w.restoreOf(s, backup.capturedAt);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/page|damaged/);
    expect(w.order).toEqual(['stage']);
    expect(w.driver.idsOf(w.object(s))).toHaveLength(1);
    expect(w.driver.stageOf(w.object(s))).toBeUndefined();
  });

  it('a commit refused after the host load stops before the deployment load, leaving the store as it was, and a new restore finishes it', async () => {
    const w = world();
    const { s, backup } = await backedUp(w, 15);
    w.driver.put(w.object(s), 1);
    w.order.length = 0;
    // An erase racing the restore dropped the stage, as the contract has it.
    w.driver.intercept((call) => {
      if (call.operation === 'substrat.commit-stage') {
        w.order.push('commit');
        return Response.json({ error: { code: 'stage_refused', status: 409 } });
      }
      if (call.operation === 'substrat.stage-page') w.order.push('stage');
      return undefined;
    });
    const failed = await w.restoreOf(s, backup.capturedAt);
    expect(failed.status).toBe(409);
    expect(w.order).toEqual(['stage', 'stage', 'host-load', 'commit']);
    expect(w.driver.idsOf(w.object(s))).toHaveLength(1);
    expect(w.driver.stageOf(w.object(s))).toBeUndefined();

    w.driver.intercept(undefined);
    expect((await w.restoreOf(s, backup.capturedAt)).status).toBe(200);
    expect(w.driver.idsOf(w.object(s))).toHaveLength(15);
  });

  it('the erasure replay still runs after the commit: a subject erased since the backup stays erased', async () => {
    const w = world();
    const s = await graphScope();
    w.driver.put(w.object(s), 25);
    const res = await w.post(`/scopes/${s}/backups`);
    const backup = (await res.json()) as ScopeBackup;
    // Erasure reaches the live store and not the page object at rest, as with a dump held inline.
    await host.admin.shredSubject(staff, t, s, 'n7');
    const page = w.parts().find((key) => key.endsWith('000000.json'))!;
    expect(w.r2.objects.get(page)!.body).toContain('"n7"');
    const restored = await w.restoreOf(s, backup.capturedAt);
    expect(restored.status).toBe(200);
    expect(w.driver.idsOf(w.object(s))).not.toContain('n7');
    expect(w.driver.idsOf(w.object(s))).toHaveLength(24);
    expect(await restored.json()).toMatchObject({ storeErasuresReplayed: 1 });
  });

  describe('a restore that fails once a commit was attempted (D-69)', () => {
    it('the second of two bindings refused: the first stays committed, the replay runs, and the answer says so', async () => {
      const w = world();
      const s = await graphScope(['GRAPH', 'OTHER']);
      w.driver.put(w.object(s), 15);
      w.driver.put(w.object(s, 'OTHER'), 15);
      const backup = (await (await w.post(`/scopes/${s}/backups`)).json()) as ScopeBackup;
      await host.admin.shredSubject(staff, t, s, 'n7');
      w.driver.put(w.object(s), 1);
      w.driver.put(w.object(s, 'OTHER'), 1);
      w.order.length = 0;
      w.driver.intercept((call) => (call.operation === 'substrat.commit-stage' && call.objectName === w.object(s, 'OTHER')
        ? Response.json({ error: { code: 'stage_refused', status: 409 } })
        : undefined));
      const res = await w.restoreOf(s, backup.capturedAt);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ committedStores: ['GRAPH'], incomplete: true, storeErasuresReplayed: 2 });
      expect(w.driver.idsOf(w.object(s))).toHaveLength(14);
      expect(w.driver.idsOf(w.object(s))).not.toContain('n7');
      expect(w.driver.idsOf(w.object(s, 'OTHER'))).toHaveLength(1);
      expect(w.order).not.toContain('deployment-load');
    });

    it('every answer of a commit lost: it may have landed, so the replay runs and the binding is named as unknown', async () => {
      const w = world();
      const { s, backup } = await backedUp(w, 15);
      await host.admin.shredSubject(staff, t, s, 'n7');
      w.driver.put(w.object(s), 1);
      w.driver.intercept((call) => (call.operation === 'substrat.commit-stage' ? 'lost' : undefined));
      const res = await w.restoreOf(s, backup.capturedAt);
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ committedStores: [], commitUnknown: 'GRAPH', incomplete: true });
      expect(w.driver.idsOf(w.object(s))).toHaveLength(14);
      expect(w.driver.idsOf(w.object(s))).not.toContain('n7');
    });

    it('a whole dump sent as a body keeps the same promise', async () => {
      const w = world();
      const s = await graphScope(['GRAPH', 'OTHER']);
      await host.admin.shredSubject(staff, t, s, 'old1');
      const nodes = (prefix: string) => [{ name: 'nodes', ddl: 'graph nodes', columns: ['id', 'pad'], rows: [[`${prefix}0`, 'x'], [`${prefix}1`, 'x']] }];
      const dump = {
        tenantId: t, scopeId: s, capturedAt: '2026-01-02T03:04:05.000Z',
        tables: [{ name: 'notes', ddl: 'CREATE TABLE notes (id TEXT)', columns: ['id'], rows: [['own']] }],
        stores: [{ binding: 'GRAPH', driver: 'graph', tables: nodes('old') }, { binding: 'OTHER', driver: 'graph', tables: nodes('other') }],
      };
      w.driver.intercept((call) => (call.operation === 'substrat.commit-stage' && call.objectName === w.object(s, 'OTHER')
        ? Response.json({ error: { code: 'stage_refused', status: 409 } })
        : undefined));
      const res = await w.post(`/scopes/${s}/restore`, dump);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ committedStores: ['GRAPH'], incomplete: true });
      expect(w.driver.idsOf(w.object(s))).toEqual(['old0']);
    });

    it('a deployment refusing the load after the commits: the stores stay replaced, and the answer names them', async () => {
      const w = world();
      const { s, backup } = await backedUp(w, 15);
      w.driver.put(w.object(s), 1);
      w.hooks.deploymentLoad = async () => { throw new ControlPlaneError(422, 'this release cannot load that dump'); };
      const res = await w.restoreOf(s, backup.capturedAt);
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ committedStores: ['GRAPH'], incomplete: true });
      expect(w.driver.idsOf(w.object(s))).toHaveLength(15);
    });
  });

  describe('a scope reaped (D-69)', () => {
    it('refuses before anything is staged, with or without a deployment', async () => {
      const w = world();
      const { s, backup } = await backedUp(w, 15);
      await reap(s);
      w.order.length = 0;
      const res = await w.restoreOf(s, backup.capturedAt);
      expect(res.status).toBe(409);
      expect(w.order).toEqual([]);
      const bare = createControlPlaneApi({
        host, authenticate: UNSAFE_devPlatformActorAuth(), storeDrivers: [graph],
        platformScopeStores: platformOver(w.driver), scopeBackups: w.backups, storeRequestBudget: roomy,
      });
      const none = await bare.request(`/tenants/${t}/scopes/${s}/backups/restore`, { method: 'POST', headers: auth, body: JSON.stringify({ capturedAt: backup.capturedAt }) });
      expect(none.status).toBe(409);
      expect(w.driver.callsOf('substrat.commit-stage')).toBe(0);
    });

    it('reaped while staging: refused before the load, and its stage is discarded', async () => {
      const w = world();
      const { s, backup } = await backedUp(w, 15);
      w.order.length = 0;
      let reaped = false;
      w.driver.before(async (call) => {
        if (call.operation === 'substrat.stage-page' && (call.input as { seq: number }).seq === 1 && !reaped) {
          reaped = true;
          await reap(s);
        }
      });
      const res = await w.restoreOf(s, backup.capturedAt);
      expect(res.status).toBe(409);
      expect(w.order).toEqual(['stage', 'stage']);
      expect(w.driver.stageOf(w.object(s))).toBeUndefined();
    });

    it('reaped during the host load: no commit follows', async () => {
      const w = world();
      const { s, backup } = await backedUp(w, 15);
      w.hooks.hostLoad = () => reap(s);
      w.order.length = 0;
      expect((await w.restoreOf(s, backup.capturedAt)).status).toBe(409);
      expect(w.order).toEqual(['stage', 'stage', 'host-load']);
    });

    it('reaped while a backup moves its pages in the request: no index lands', async () => {
      const w = world();
      const s = await graphScope();
      w.driver.put(w.object(s), 15);
      w.driver.before(async (call) => {
        if (call.operation === 'substrat.export-page' && (call.input as { cursor: unknown }).cursor === '10') await reap(s);
      });
      expect((await w.post(`/scopes/${s}/backups`)).status).toBe(409);
      expect(w.parts()).toEqual([]);
    });
  });

  it('a binding the running version no longer declares refuses before anything is staged', async () => {
    const w = world();
    const { s, backup } = await backedUp(w, 15);
    await bindVersion(s, ['OTHER']);
    w.order.length = 0;
    const res = await w.restoreOf(s, backup.capturedAt);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain("'GRAPH'");
    expect(w.order).toEqual([]);
  });

  describe('a reap\'s backup comes back in a new scope (D-69)', () => {
    it('reap with a backup, restore into a new scope: every row back, the erasure replayed', async () => {
      const w = world();
      const s = await graphScope();
      w.driver.put(w.object(s), 25);
      await host.admin.shredSubject(staff, t, s, 'n7');
      await host.admin.archiveScope(staff, t, s);
      const reaped = await w.post(`/scopes/${s}/reap`, {});
      expect(reaped.status, await reaped.clone().text()).toBe(200);
      expect(w.driver.idsOf(w.object(s))).toEqual([]);
      const [{ capturedAt }] = (await (await w.api.request(`/tenants/${t}/scopes/${s}/backups`, { headers: auth })).json()) as ScopeBackup[];

      const fresh = await graphScope();
      const res = await w.restoreOf(fresh, capturedAt!, s);
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await res.json()).toMatchObject({ restored: fresh, storeErasuresReplayed: expect.any(Number) });
      expect(w.driver.idsOf(w.object(fresh))).toEqual(Array.from({ length: 25 }, (_, i) => `n${i}`).filter((id) => id !== 'n7'));
      expect(w.order).toContain('deployment-load');
    });

    it('a large one runs as a job keyed by where it lands, which a poll without the source does not match', async () => {
      const w = world({ budget: tight, jobs: true });
      const s = await graphScope();
      w.driver.put(w.object(s), 95);
      const { capturedAt } = (await (await w.post(`/scopes/${s}/backups`)).json()) as { capturedAt: string };
      await w.jobs!.pump(storeJobId('store-backup', s));
      await host.admin.archiveScope(staff, t, s);
      expect((await w.post(`/scopes/${s}/reap`, { backup: false })).status).toBe(200);

      const fresh = await graphScope();
      expect((await w.restoreOf(fresh, capturedAt, s)).status).toBe(202);
      expect(await w.jobs!.get(storeJobId('store-restore', fresh))).toMatchObject({ spec: { scopeId: fresh, sourceScopeId: s } });
      expect((await w.restoreOf(fresh, capturedAt)).status).toBe(409);
      await w.jobs!.pump(storeJobId('store-restore', fresh));
      expect(w.driver.idsOf(w.object(fresh))).toEqual([]);
      const done = await w.restoreOf(fresh, capturedAt, s);
      expect(done.status, await done.clone().text()).toBe(200);
      expect(w.driver.idsOf(w.object(fresh))).toHaveLength(95);
    });

    it('a source scope that is not this tenant\'s is unknown, and nothing is read', async () => {
      const w = world();
      const fresh = await graphScope();
      const res = await w.restoreOf(fresh, '2026-01-01T00:00:00.000Z', scopeId.parse(ulid()));
      expect(res.status).toBe(404);
      expect(w.driver.calls).toEqual([]);
    });

    it('the body route refuses a reaped scope as well, naming the way', async () => {
      const w = world();
      const s = await graphScope();
      await reap(s);
      const dump = { tenantId: t, scopeId: s, capturedAt: '2026-01-02T03:04:05.000Z', tables: [{ name: 'notes', ddl: 'CREATE TABLE notes (id TEXT)', columns: ['id'], rows: [] }] };
      w.order.length = 0;
      const res = await w.post(`/scopes/${s}/restore`, dump);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('new scope');
      expect(w.order).toEqual([]);
    });
  });

  describe('a reap stops the scope\'s store jobs (D-69)', () => {
    it('a backup still moving is dropped, so no copy lands after a reap without one', async () => {
      const w = world({ budget: tight, jobs: true });
      const s = await graphScope();
      w.driver.put(w.object(s), 95);
      await w.post(`/scopes/${s}/backups`);
      expect(w.parts().length).toBeGreaterThan(0);
      await host.admin.archiveScope(staff, t, s);
      expect((await w.post(`/scopes/${s}/reap`, { backup: false })).status).toBe(200);
      expect(w.parts()).toEqual([]);
      expect(await w.jobs!.get(storeJobId('store-backup', s))).toBeNull();
    });

    it('a backup that finished stays, as any held copy does', async () => {
      const w = world({ budget: tight, jobs: true });
      const s = await graphScope();
      w.driver.put(w.object(s), 95);
      const { capturedAt } = (await (await w.post(`/scopes/${s}/backups`)).json()) as { capturedAt: string };
      await w.jobs!.pump(storeJobId('store-backup', s));
      await host.admin.archiveScope(staff, t, s);
      expect((await w.post(`/scopes/${s}/reap`, { backup: false })).status).toBe(200);
      expect(await w.backups.getIndex({ tenantId: t, scopeId: s, capturedAt })).not.toBeNull();
    });

    it('a restore a call is finishing refuses the reap; one waiting has its stage discarded', async () => {
      const w = world({ budget: tight, jobs: true });
      const s = await graphScope();
      w.driver.put(w.object(s), 95);
      const { capturedAt } = (await (await w.post(`/scopes/${s}/backups`)).json()) as { capturedAt: string };
      await w.jobs!.pump(storeJobId('store-backup', s));
      await w.restoreOf(s, capturedAt);
      await w.jobs!.pump(storeJobId('store-restore', s));
      const id = storeJobId('store-restore', s);
      const stage = w.jobs!.jobs.get(id)!.done!.moved[0]!.moveId;
      await host.admin.archiveScope(staff, t, s);
      await w.jobs!.claim(id, 60_000);
      const held = await w.post(`/scopes/${s}/reap`, { backup: false });
      expect(held.status).toBe(409);
      expect((await host.admin.getScopeRecord(staff, t, s))?.status).toBe('archived');
      w.jobs!.jobs.set(id, { ...w.jobs!.jobs.get(id)!, claimedUntil: 0 });
      expect((await w.post(`/scopes/${s}/reap`, { backup: false })).status).toBe(200);
      expect(w.driver.calls.filter((call) => call.operation === 'substrat.discard-stage' && (call.input as { stageId: string }).stageId === stage)).toHaveLength(1);
      expect(await w.jobs!.get(id)).toBeNull();
    });

    it('a scope archived while a restore stages refuses before the load: a reap is coming', async () => {
      const w = world();
      const { s, backup } = await backedUp(w, 15);
      w.order.length = 0;
      let archived = false;
      w.driver.before(async (call) => {
        if (call.operation === 'substrat.stage-page' && !archived) {
          archived = true;
          await host.admin.archiveScope(staff, t, s);
        }
      });
      expect((await w.restoreOf(s, backup.capturedAt)).status).toBe(409);
      expect(w.order).not.toContain('host-load');
    });
  });

  describe('a scope a reap has marked takes no restore (D-70)', () => {
    it('refuses both restore routes before any load or stage, naming a new scope', async () => {
      const w = world();
      const { s, backup } = await backedUp(w, 15);
      const dump = { tenantId: t, scopeId: s, capturedAt: '2026-01-02T03:04:05.000Z', tables: [{ name: 'notes', ddl: 'CREATE TABLE notes (id TEXT)', columns: ['id'], rows: [['own']] }] };
      await host.admin.archiveScope(staff, t, s);
      await host.admin.markScopeStoresFenced(staff, t, s);
      w.order.length = 0;
      for (const res of [await w.restoreOf(s, backup.capturedAt), await w.post(`/scopes/${s}/restore`, dump)]) {
        expect(res.status).toBe(409);
        expect(JSON.stringify(await res.json())).toContain('a new scope');
      }
      expect(w.order).toEqual([]);
    });
  });

  describe('a reap that lands during a restore run in a request (D-70)', () => {
    it('a restore into a scope already archived, whose reap fences it before the commit, commits nothing', async () => {
      const w = world();
      const { s, backup } = await backedUp(w, 15);
      await host.admin.archiveScope(staff, t, s);
      w.order.length = 0;
      let reaped = false;
      w.driver.before(async (call) => {
        if (call.operation === 'substrat.commit-stage' && !reaped) {
          reaped = true;
          await platformOver(w.driver).fenceStores({ tenantId: t, scopeId: s, vertical: VERTICAL, stores: [{ binding: 'GRAPH', driver: 'graph' }] });
        }
      });
      const res = await w.restoreOf(s, backup.capturedAt);
      expect(reaped).toBe(true);
      expect(res.status).toBe(410);
      expect(w.driver.rowsOf(w.object(s))).toBe(0);
      expect(w.order).not.toContain('deployment-load');
    });
  });

  describe('races and stopped jobs (D-69)', () => {
    const otherJob = (s: ScopeId, kind: 'store-backup' | 'store-restore') => ({
      spec: {
        id: storeJobId(kind, s), kind, tenantId: t, scopeId: s, vertical: VERTICAL, capturedAt: '2020-01-01T00:00:00.000Z',
        ...(kind === 'store-backup' ? { scopeObject: { key: 'other', bytes: 0, digest: '0'.repeat(64), tables: 0 } } : {}),
        actor: staff, startedAt: Date.now(), deadline: Date.now() + 60_000,
      },
      status: 'copying' as const,
      state: { stores: [{ binding: 'GRAPH', driver: 'graph' }], at: 0, move: { moveId: ulid(), seq: 0, cursor: null, revision: null, attempt: 1, reads: 0, tableNames: [], rows: 0 }, moved: [], pages: 0 },
      pages: 0, rows: 0, attempt: 1, faults: 0, nextDelayMs: 0, updatedAt: Date.now(),
    });

    it('a backup that lost the race to start its job gives up what it wrote', async () => {
      const w = world({ budget: tight, jobs: true });
      const s = await graphScope();
      w.driver.put(w.object(s), 95);
      w.driver.before(async (call) => {
        if (call.operation === 'substrat.export-page' && (call.input as { cursor: unknown }).cursor === '10') w.jobs!.jobs.set(storeJobId('store-backup', s), otherJob(s, 'store-backup'));
      });
      const res = await w.post(`/scopes/${s}/backups`);
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ capturedAt: '2020-01-01T00:00:00.000Z' });
      expect(w.parts()).toEqual([]);
    });

    it('a backup job whose steps stopped has what it wrote deleted, and a new one starts', async () => {
      const w = world({ budget: tight, jobs: true });
      const s = await graphScope();
      w.driver.put(w.object(s), 95);
      await w.post(`/scopes/${s}/backups`);
      const id = storeJobId('store-backup', s);
      const stalled = w.jobs!.jobs.get(id)!;
      const oldKeys = w.parts();
      w.jobs!.jobs.set(id, { ...stalled, updatedAt: 0 });
      expect((await w.post(`/scopes/${s}/backups`)).status).toBe(202);
      for (const key of oldKeys) expect(w.parts()).not.toContain(key);
    });

    it('a restore job whose steps stopped has its stage discarded, and says so to whoever asks', async () => {
      const w = world({ budget: tight, jobs: true });
      const s = await graphScope();
      w.driver.put(w.object(s), 95);
      const { capturedAt } = (await (await w.post(`/scopes/${s}/backups`)).json()) as { capturedAt: string };
      await w.jobs!.pump(storeJobId('store-backup', s));
      await w.restoreOf(s, capturedAt);
      expect(w.driver.stageOf(w.object(s))).toBeDefined();
      const id = storeJobId('store-restore', s);
      w.jobs!.jobs.set(id, { ...w.jobs!.jobs.get(id)!, updatedAt: 0 });
      const res = await w.restoreOf(s, capturedAt);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('no progress');
      expect(w.driver.stageOf(w.object(s))).toBeUndefined();
    });
  });

  describe('a store may bring restored data forward after its commit (D-69)', () => {
    const busy = () => Response.json({ error: { code: 'migrating', status: 503 } });
    /** A wait on a clock of its own: sleeping moves it, and nothing really waits. */
    const clock = (waitMs = 10_000) => {
      let at = 0;
      const slept: number[] = [];
      const ready: StoreReadyWait = { waitMs, now: () => at, sleep: async (ms) => { slept.push(ms); at += ms; } };
      return { slept, ready, total: () => slept.reduce((n, ms) => n + ms, 0) };
    };
    const selfchecks = (w: ReturnType<typeof world>) => w.driver.callsOf('substrat.selfcheck');

    it('a store that answers 503 past the call retries and then ok is waited for, and the restore completes', async () => {
      const k = clock();
      const w = world({ ready: k.ready });
      const { s, backup } = await backedUp(w, 15);
      w.driver.put(w.object(s), 1);
      w.order.length = 0;
      // Three tries make one probe (the caller retries a 503 twice), so five answers outlast the first probe.
      let busyFor = 5;
      w.driver.intercept((call) => (call.operation === 'substrat.selfcheck' && busyFor-- > 0 ? busy() : undefined));
      const res = await w.restoreOf(s, backup.capturedAt);
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await res.json()).not.toHaveProperty('incomplete');
      expect(selfchecks(w)).toBe(6);
      expect(k.slept).toEqual([500]);
      expect(w.driver.idsOf(w.object(s))).toHaveLength(15);
      expect(w.order).toContain('deployment-load');
    });

    it('the probe sits after the commits and before the erasure replay and the deployment load', async () => {
      const w = world({ ready: clock().ready });
      const { s, backup } = await backedUp(w, 15);
      await host.admin.shredSubject(staff, t, s, 'n7');
      w.order.length = 0;
      w.driver.intercept((call) => {
        if (call.operation === 'substrat.selfcheck') w.order.push('selfcheck');
        if (call.operation === 'substrat.commit-stage') w.order.push('commit');
        if (call.operation === 'substrat.erase') w.order.push('erase');
        return undefined;
      });
      expect((await w.restoreOf(s, backup.capturedAt)).status).toBe(200);
      const at = (step: string) => w.order.indexOf(step);
      expect(at('host-load')).toBeLessThan(at('commit'));
      expect(at('commit')).toBeLessThan(at('selfcheck'));
      expect(at('selfcheck')).toBeLessThan(at('erase'));
      expect(at('erase')).toBeLessThan(at('deployment-load'));
    });

    it('a store whose check answers 500 is named, the restore is incomplete, and nothing waits', async () => {
      const k = clock();
      const w = world({ ready: k.ready });
      const s = await graphScope(['GRAPH', 'OTHER']);
      w.driver.put(w.object(s), 15);
      w.driver.put(w.object(s, 'OTHER'), 15);
      const backup = (await (await w.post(`/scopes/${s}/backups`)).json()) as ScopeBackup;
      w.driver.put(w.object(s), 1);
      w.driver.put(w.object(s, 'OTHER'), 1);
      w.order.length = 0;
      w.driver.intercept((call) => (call.operation === 'substrat.selfcheck' && call.objectName === w.object(s, 'OTHER')
        ? Response.json({ error: { code: 'step_failed', status: 500, body: 'ALTER TABLE nodes: secret detail' } })
        : undefined));
      const res = await w.restoreOf(s, backup.capturedAt);
      const answer = await res.json();
      expect(res.status).toBe(502);
      expect(answer).toMatchObject({ committedStores: ['GRAPH', 'OTHER'], storesNotReady: ['OTHER'], incomplete: true });
      expect(JSON.stringify(answer)).not.toContain('secret detail');
      expect(JSON.stringify(answer)).toContain('a release with a repaired step is the way out');
      expect(k.slept).toEqual([]);
      expect(w.driver.idsOf(w.object(s))).toHaveLength(15);
      expect(w.order).not.toContain('deployment-load');
    });

    it('a store that never leaves 503 is waited for no longer than the bound, then named, in a request', async () => {
      const k = clock();
      const w = world({ ready: k.ready });
      const { s, backup } = await backedUp(w, 15);
      w.driver.put(w.object(s), 1);
      w.order.length = 0;
      w.driver.intercept((call) => (call.operation === 'substrat.selfcheck' ? busy() : undefined));
      const res = await w.restoreOf(s, backup.capturedAt);
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ committedStores: ['GRAPH'], storesNotReady: ['GRAPH'], incomplete: true });
      expect(k.total()).toBe(10_000);
      expect(selfchecks(w)).toBeLessThan(30);
      expect(w.order).not.toContain('deployment-load');
    });

    it('the same when the restore ran as a job and a second call finished it', async () => {
      const k = clock();
      const w = world({ budget: tight, jobs: true, ready: k.ready });
      const s = await graphScope();
      w.driver.put(w.object(s), 95);
      const { capturedAt } = (await (await w.post(`/scopes/${s}/backups`)).json()) as { capturedAt: string };
      await w.jobs!.pump(storeJobId('store-backup', s));
      expect((await w.restoreOf(s, capturedAt)).status).toBe(202);
      await w.jobs!.pump(storeJobId('store-restore', s));
      expect(w.jobs!.jobs.get(storeJobId('store-restore', s))?.status).toBe('done');
      w.driver.intercept((call) => (call.operation === 'substrat.selfcheck' ? busy() : undefined));
      const res = await w.restoreOf(s, capturedAt);
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ committedStores: ['GRAPH'], storesNotReady: ['GRAPH'], incomplete: true });
      expect(k.total()).toBe(10_000);
      expect(await w.jobs!.get(storeJobId('store-restore', s))).toBeNull();
    });

    it('a whole dump sent as a body is probed the same way', async () => {
      const k = clock();
      const w = world({ ready: k.ready });
      const s = await graphScope();
      const dump = {
        tenantId: t, scopeId: s, capturedAt: '2026-01-02T03:04:05.000Z',
        tables: [{ name: 'notes', ddl: 'CREATE TABLE notes (id TEXT)', columns: ['id'], rows: [['own']] }],
        stores: [{ binding: 'GRAPH', driver: 'graph', tables: [{ name: 'nodes', ddl: 'graph nodes', columns: ['id', 'pad'], rows: [['a', 'x']] }] }],
      };
      let busyFor = 4;
      w.driver.intercept((call) => (call.operation === 'substrat.selfcheck' && busyFor-- > 0 ? busy() : undefined));
      expect((await w.post(`/scopes/${s}/restore`, dump)).status).toBe(200);
      expect(k.slept).toEqual([500]);
      w.driver.intercept((call) => (call.operation === 'substrat.selfcheck' ? Response.json({ error: { code: 'step_failed', status: 500 } }) : undefined));
      const failed = await w.post(`/scopes/${s}/restore`, dump);
      expect(failed.status).toBe(502);
      expect(await failed.json()).toMatchObject({ committedStores: ['GRAPH'], storesNotReady: ['GRAPH'], incomplete: true });
    });

    describe('a backup whose source answers 503, a store migrating', () => {
      it('in a request says the store is busy, and nothing is kept', async () => {
        const w = world();
        const s = await graphScope();
        w.driver.put(w.object(s), 15);
        w.driver.intercept((call) => (call.operation === 'substrat.export-page' ? busy() : undefined));
        const res = await w.post(`/scopes/${s}/backups`);
        expect(res.status).toBe(503);
        expect(((await res.json()) as { error: string }).error).toContain('is busy');
        expect(w.parts()).toEqual([]);
      });

      it('in a job waits with a growing backoff past the faults a job rides out, and finishes when the store clears', async () => {
        const w = world({ budget: tight, jobs: true });
        const s = await graphScope();
        w.driver.put(w.object(s), 95);
        expect((await w.post(`/scopes/${s}/backups`)).status).toBe(202);
        const id = storeJobId('store-backup', s);
        w.driver.intercept((call) => (call.operation === 'substrat.export-page' ? busy() : undefined));
        const delays: number[] = [];
        for (let i = 0; i < STORE_JOB_MAX_FAULTS + 4; i += 1) {
          const job = (await w.jobs!.pump(id))!;
          expect(job.status).toBe('copying');
          expect(job.faults).toBe(0);
          delays.push(job.nextDelayMs);
        }
        expect(delays.slice(0, 5)).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
        expect(Math.max(...delays)).toBeLessThanOrEqual(60_000);
        w.driver.intercept(undefined);
        const done = (await w.jobs!.pump(id))!;
        expect(done.status).toBe('done');
        expect(done.done?.backup).toBeDefined();
      });

      it('in a job honours a Retry-After, and still fails a store that is not busy', async () => {
        const w = world({ budget: tight, jobs: true });
        const s = await graphScope();
        w.driver.put(w.object(s), 95);
        await w.post(`/scopes/${s}/backups`);
        const id = storeJobId('store-backup', s);
        w.driver.intercept((call) => (call.operation === 'substrat.export-page'
          ? new Response(JSON.stringify({ error: { code: 'migrating', status: 503 } }), { status: 503, headers: { 'retry-after': '45' } })
          : undefined));
        expect((await w.jobs!.pump(id))!.nextDelayMs).toBe(45_000);
        w.driver.intercept((call) => (call.operation === 'substrat.export-page' ? Response.json({ error: { code: 'step_failed', status: 500 } }) : undefined));
        let job = (await w.jobs!.pump(id))!;
        for (let i = 0; i < STORE_JOB_MAX_FAULTS && job.status === 'copying'; i += 1) job = (await w.jobs!.pump(id))!;
        expect(job.status).toBe('failed');
      });
    });
  });

  describe('a commit whose fate cannot be told (D-69)', () => {
    it('first answer lost, the retry refused: the store was replaced, so the binding is unknown, not unreplaced', async () => {
      const w = world();
      const { s, backup } = await backedUp(w, 15);
      w.driver.put(w.object(s), 1);
      w.driver.intercept((call) => {
        if (call.operation !== 'substrat.commit-stage') return undefined;
        return call.nth === 1 ? 'lost' : Response.json({ error: { code: 'stage_refused', status: 409 } });
      });
      const res = await w.restoreOf(s, backup.capturedAt);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ committedStores: [], commitUnknown: 'GRAPH', incomplete: true });
      expect(w.driver.idsOf(w.object(s))).toHaveLength(15);
    });

    it('a refusal on the first try says the commit did not land', async () => {
      const w = world();
      const { s, backup } = await backedUp(w, 15);
      w.driver.intercept((call) => (call.operation === 'substrat.commit-stage' ? Response.json({ error: { code: 'stage_refused', status: 409 } }) : undefined));
      const body = (await (await w.restoreOf(s, backup.capturedAt)).json()) as { commitUnknown?: string };
      expect(body.commitUnknown).toBeUndefined();
    });

    it('a whole dump\'s commit with its answers lost names the binding too', async () => {
      const w = world();
      const s = await graphScope();
      const dump = {
        tenantId: t, scopeId: s, capturedAt: '2026-01-02T03:04:05.000Z',
        tables: [{ name: 'notes', ddl: 'CREATE TABLE notes (id TEXT)', columns: ['id'], rows: [['own']] }],
        stores: [{ binding: 'GRAPH', driver: 'graph', tables: [{ name: 'nodes', ddl: 'graph nodes', columns: ['id', 'pad'], rows: [['a', 'x']] }] }],
      };
      w.driver.intercept((call) => (call.operation === 'substrat.commit-stage' ? 'lost' : undefined));
      const res = await w.post(`/scopes/${s}/restore`, dump);
      expect(await res.json()).toMatchObject({ commitUnknown: 'GRAPH', incomplete: true });
    });

    it('a replay that itself throws after a failed commit is reported, and the refusal still answers', async () => {
      const w = world();
      const { s, backup } = await backedUp(w, 15);
      w.driver.intercept((call) => (call.operation === 'substrat.commit-stage' ? Response.json({ error: { code: 'stage_refused', status: 409 } }) : undefined));
      w.hooks.shreddedRead = async () => { throw new Error('the directory did not answer'); };
      const res = await w.restoreOf(s, backup.capturedAt);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ committedStores: [], incomplete: true, storeErasureIncomplete: true });
    });
  });

  describe('a backup held inline, from before pages', () => {
    const inlined = async (w: ReturnType<typeof world>) => {
      const s = await graphScope();
      const capturedAt = '2026-01-02T03:04:05.000Z';
      const dump: ScopeDump = {
        tenantId: t, scopeId: s, capturedAt,
        tables: [{ name: 'notes', ddl: 'CREATE TABLE notes (id TEXT)', columns: ['id'], rows: [['own']] }],
        stores: [{ binding: 'GRAPH', driver: 'graph', tables: [{ name: 'nodes', ddl: 'graph nodes', columns: ['id', 'pad'], rows: Array.from({ length: 25 }, (_, i) => [`old${i}`, 'x']) }] }],
      };
      await w.backups.put({ vertical: VERTICAL, dump });
      return { s, capturedAt };
    };

    it('restores through the backup\'s own route', async () => {
      const w = world();
      const { s, capturedAt } = await inlined(w);
      w.driver.put(w.object(s), 1);
      const res = await w.restoreOf(s, capturedAt);
      expect(res.status, await res.clone().text()).toBe(200);
      expect(w.driver.idsOf(w.object(s))).toHaveLength(25);
      expect(w.driver.idsOf(w.object(s))[0]).toBe('old0');
    });

    it('restores when read back and sent as a body, as it always did', async () => {
      const w = world();
      const { s, capturedAt } = await inlined(w);
      const dump = (await (await w.api.request(`/tenants/${t}/scopes/${s}/backups/${capturedAt}`, { headers: auth })).json()) as ScopeDump;
      expect(dump.stores[0]!.tables[0]!.rows).toHaveLength(25);
      expect((await w.post(`/scopes/${s}/restore`, dump)).status).toBe(200);
      expect(w.driver.idsOf(w.object(s))).toHaveLength(25);
    });
  });

  it('a paged backup read back and sent as a body refuses, rather than load it without its stores', async () => {
    const w = world();
    const { s, backup } = await backedUp(w, 5);
    w.driver.put(w.object(s), 1);
    const dump = (await (await w.api.request(`/tenants/${t}/scopes/${s}/backups/${backup.capturedAt}`, { headers: auth })).json()) as ScopeDump;
    w.order.length = 0;
    const res = await w.post(`/scopes/${s}/restore`, dump);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain('backups/restore');
    expect(w.order).toEqual([]);
  });

  it('a backup with no index is no backup: it is not listed, not read, not restored', async () => {
    const w = world();
    const { s, backup } = await backedUp(w, 15);
    w.r2.objects.delete(`scopes/${t}/${s}/${backup.capturedAt}.json`);
    expect(w.parts().length).toBeGreaterThan(0);
    expect(await (await w.api.request(`/tenants/${t}/scopes/${s}/backups`, { headers: auth })).json()).toEqual([]);
    expect((await w.api.request(`/tenants/${t}/scopes/${s}/backups/${backup.capturedAt}`, { headers: auth })).status).toBe(404);
    expect((await w.restoreOf(s, backup.capturedAt)).status).toBe(404);
  });

  it('retention takes a backup\'s pages with it, and a page no index names', async () => {
    const w = world();
    const { s, backup } = await backedUp(w, 15);
    const orphan = `scopes/${t}/${s}/${backup.capturedAt}/stores/ORPHAN/000000.json`;
    await w.r2.bucket.put(orphan, '{"tables":[]}', { customMetadata: { capturedAt: backup.capturedAt } });
    const fresh = await pruneScopeBackups(w.r2.bucket, { olderThanDays: 1, now: () => new Date(backup.capturedAt) });
    expect(fresh).toBe(0);
    expect(w.parts()).toContain(orphan);
    const pruned = await pruneScopeBackups(w.r2.bucket, { olderThanDays: 1, now: () => new Date(Date.parse(backup.capturedAt) + 2 * 86_400_000) });
    expect(pruned).toBe(1);
    expect(w.parts()).toEqual([]);
  });

  describe('a store too large for one request', () => {
    /** A backup of `rows` rows taken through a job, and finished. */
    const jobBackup = async (w: ReturnType<typeof world>, s: ScopeId, rows = 95) => {
      w.driver.put(w.object(s), rows);
      const { capturedAt } = (await (await w.post(`/scopes/${s}/backups`)).json()) as { capturedAt: string };
      await w.jobs!.pump(storeJobId('store-backup', s));
      return (await (await w.poll(s, capturedAt)).json()) as ScopeBackup;
    };

    it('a backup with a job runs as one: 202 while it moves, then the backup to whoever names it, as often as asked', async () => {
      const w = world({ budget: tight, jobs: true });
      const s = await graphScope();
      w.driver.put(w.object(s), 95);
      const first = await w.post(`/scopes/${s}/backups`);
      expect(first.status).toBe(202);
      const answer = (await first.json()) as { copying: true; capturedAt: string; pages: number };
      expect(answer).toMatchObject({ copying: true, pages: 2 });
      expect(await (await w.api.request(`/tenants/${t}/scopes/${s}/backups`, { headers: auth })).json()).toEqual([]);
      expect((await w.poll(s, answer.capturedAt)).status).toBe(202);
      // While one moves, a call naming nothing is told of that one, under its own name.
      expect(await (await w.post(`/scopes/${s}/backups`)).json()).toMatchObject({ capturedAt: answer.capturedAt });

      await w.jobs!.pump(storeJobId('store-backup', s));
      const done = await w.poll(s, answer.capturedAt);
      expect(done.status).toBe(201);
      const backup = (await done.json()) as ScopeBackup;
      expect(backup.capturedAt).toBe(answer.capturedAt);
      const index = await w.backups.getIndex({ tenantId: t, scopeId: s, capturedAt: backup.capturedAt });
      expect(index?.stores[0]?.pageCount).toBe(10);
      expect(w.driver.held.peak).toBeLessThanOrEqual(10);
      // An answer lost on the way is asked for again: the first asker consumed nothing.
      expect(await (await w.poll(s, answer.capturedAt)).json()).toEqual(backup);
      expect(await w.jobs!.get(storeJobId('store-backup', s))).toMatchObject({ status: 'done' });
    });

    it('a later backup is never answered with an earlier one as if fresh', async () => {
      const w = world({ budget: tight, jobs: true });
      const s = await graphScope();
      const earlier = await jobBackup(w, s);
      await new Promise((resolve) => setTimeout(resolve, 2));
      const later = await w.post(`/scopes/${s}/backups`);
      expect(later.status).toBe(202);
      const { capturedAt } = (await later.json()) as { capturedAt: string };
      expect(capturedAt).not.toBe(earlier.capturedAt);
      // The earlier is still what its name says, read from what is held; another name is not a backup.
      expect(await (await w.poll(s, earlier.capturedAt)).json()).toMatchObject({ capturedAt: earlier.capturedAt, size: earlier.size });
      expect((await w.poll(s, '2020-01-01T00:00:00.000Z')).status).toBe(404);
      expect((await w.jobs!.get(storeJobId('store-backup', s)))?.spec.capturedAt).toBe(capturedAt);
    });

    it('a restore with a job stages as one, and the call that finds it done loads and commits', async () => {
      const w = world({ budget: tight, jobs: true });
      const s = await graphScope();
      const backup = await jobBackup(w, s);
      w.driver.put(w.object(s), 1);
      w.order.length = 0;

      const first = await w.restoreOf(s, backup.capturedAt);
      expect(first.status).toBe(202);
      expect((await w.restoreOf(s, backup.capturedAt)).status).toBe(202);
      expect(w.order).toEqual(['stage', 'stage']);
      // Another backup waits while this one moves; one that does not exist disturbs nothing.
      expect((await w.restoreOf(s, '2020-01-01T00:00:00.000Z')).status).toBe(409);
      await w.jobs!.pump(storeJobId('store-restore', s));
      expect(w.driver.idsOf(w.object(s))).toHaveLength(1);
      expect((await w.restoreOf(s, '2020-01-01T00:00:00.000Z')).status).toBe(404);

      const done = await w.restoreOf(s, backup.capturedAt);
      expect(done.status, await done.clone().text()).toBe(200);
      expect(w.driver.idsOf(w.object(s))).toHaveLength(95);
      expect(w.order.slice(-3)).toEqual(['host-load', 'commit', 'deployment-load']);
      expect(await w.jobs!.get(storeJobId('store-restore', s))).toBeNull();
    });

    it('a job started first by another call for another backup is not this call\'s: it refuses, and leaves that stage alone', async () => {
      const w = world({ budget: tight, jobs: true });
      const s = await graphScope();
      const backup = await jobBackup(w, s);
      const id = storeJobId('store-restore', s);
      const otherStage = { binding: 'GRAPH', driver: 'graph' };
      w.driver.before(async (call) => {
        if (call.operation === 'substrat.stage-page' && (call.input as { seq: number }).seq === 1 && !w.jobs!.jobs.has(id)) {
          w.jobs!.jobs.set(id, {
            spec: { id, kind: 'store-restore', tenantId: t, scopeId: s, vertical: VERTICAL, capturedAt: '2020-01-01T00:00:00.000Z', actor: staff, startedAt: Date.now(), deadline: Date.now() + 60_000 },
            status: 'copying', state: { stores: [otherStage], at: 0, move: { moveId: ulid(), seq: 0, cursor: null, revision: null, attempt: 1, tableNames: [], rows: 0 }, moved: [], pages: 0 },
            pages: 0, rows: 0, attempt: 1, faults: 0, nextDelayMs: 0, updatedAt: Date.now(),
          });
        }
      });
      const res = await w.restoreOf(s, backup.capturedAt);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('2020-01-01');
      expect(w.driver.stageOf(w.object(s))).toBeUndefined();
    });

    it.each([
      ['an erase came between, which drops every stage', (w: ReturnType<typeof world>, s: ScopeId) =>
        platformOver(w.driver).eraseSubject({ tenantId: t, scopeId: s, vertical: VERTICAL, subjectId: 'nobody', stores: [{ binding: 'GRAPH', driver: 'graph' }] })],
      ['the call came late, after the stage aged out', async (w: ReturnType<typeof world>, s: ScopeId) => {
        w.driver.objects.get(w.object(s))!.stage = undefined;
      }],
    ])('%s: it fails cleanly, and asking again starts over', async (_what, drop) => {
      const w = world({ budget: tight, jobs: true });
      const s = await graphScope();
      const backup = await jobBackup(w, s);
      w.driver.put(w.object(s), 1);
      await w.restoreOf(s, backup.capturedAt);
      await w.jobs!.pump(storeJobId('store-restore', s));
      await drop(w, s);
      w.order.length = 0;
      const refused = await w.restoreOf(s, backup.capturedAt);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ committedStores: [], incomplete: true });
      expect(w.order).not.toContain('deployment-load');
      expect(w.driver.idsOf(w.object(s))).toHaveLength(1);
      expect(await w.jobs!.get(storeJobId('store-restore', s))).toBeNull();
      expect((await w.restoreOf(s, backup.capturedAt)).status).toBe(202);
      await w.jobs!.pump(storeJobId('store-restore', s));
      expect((await w.restoreOf(s, backup.capturedAt)).status).toBe(200);
      expect(w.driver.idsOf(w.object(s))).toHaveLength(95);
    });

    it('a restore staged and left waiting gives way to a restore of another backup, and its stage goes', async () => {
      const w = world({ budget: tight, jobs: true });
      const s = await graphScope();
      const older = await jobBackup(w, s);
      await new Promise((resolve) => setTimeout(resolve, 2));
      w.driver.put(w.object(s), 15);
      const newer = (await (await w.post(`/scopes/${s}/backups`)).json()) as { capturedAt: string };
      await w.jobs!.pump(storeJobId('store-backup', s));
      await w.poll(s, newer.capturedAt);
      await w.restoreOf(s, older.capturedAt);
      const waiting = (await w.jobs!.pump(storeJobId('store-restore', s)))!.done!.moved[0]!.moveId;
      const res = await w.restoreOf(s, newer.capturedAt);
      expect(res.status, await res.clone().text()).toBe(200);
      expect(w.driver.calls.filter((call) => call.operation === 'substrat.discard-stage' && (call.input as { stageId: string }).stageId === waiting)).toHaveLength(1);
      expect(w.driver.idsOf(w.object(s))).toHaveLength(15);
    });

    it('a job that failed answers whoever names it, and a call naming nothing starts over', async () => {
      const w = world({ budget: tight, jobs: true });
      const s = await graphScope();
      w.driver.put(w.object(s), 95);
      const { capturedAt } = (await (await w.post(`/scopes/${s}/backups`)).json()) as { capturedAt: string };
      w.driver.intercept((call) => (call.operation === 'substrat.export-page' ? Response.json({ error: { code: 'forbidden', status: 403 } }) : undefined));
      await w.jobs!.pump(storeJobId('store-backup', s));
      expect((await w.poll(s, capturedAt)).status).toBe(403);
      expect((await w.poll(s, capturedAt)).status).toBe(403);
      expect(w.parts()).toEqual([]);
      w.driver.intercept(undefined);
      expect((await w.post(`/scopes/${s}/backups`)).status).toBe(202);
    });

    it('a store whose size says it could never fit refuses up front, with nothing written', async () => {
      const w = world({ budget: tight, jobs: true });
      const s = await graphScope();
      w.driver.intercept((call) => (call.operation === 'substrat.size' ? Response.json({ result: { bytes: 1e15 } }) : undefined));
      const res = await w.post(`/scopes/${s}/backups`);
      expect(res.status).toBe(413);
      expect(w.parts()).toEqual([]);
    });

    it('with no job a backup refuses, saying so, and leaves nothing', async () => {
      const w = world({ budget: tight });
      const s = await graphScope();
      w.driver.put(w.object(s), 95);
      const res = await w.post(`/scopes/${s}/backups`);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('runs no job');
      expect(w.parts()).toEqual([]);
    });

    it('a reap refuses in the request, names the backup route and keeps the scope', async () => {
      const w = world({ budget: tight, jobs: true });
      const s = await graphScope();
      w.driver.put(w.object(s), 95);
      await host.admin.archiveScope(staff, t, s);
      const res = await w.post(`/scopes/${s}/reap`, {});
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('POST …/backups');
      expect((await host.admin.getScopeRecord(staff, t, s))?.status).toBe('archived');
      expect(w.driver.idsOf(w.object(s))).toHaveLength(95);
      expect(w.parts()).toEqual([]);
    });

    it('a restore with no job refuses and leaves no stage', async () => {
      const w = world();
      const { s, backup } = await backedUp(w, 95);
      const small = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        storeDrivers: [graph],
        platformScopeStores: platformOver(w.driver),
        scopeBackups: w.backups,
        verticals: { [VERTICAL]: { restoreScope: async () => ({ tables: 1 }) } as unknown as VerticalClient },
        storeRequestBudget: tight,
      });
      w.driver.put(w.object(s), 1);
      const res = await small.request(`/tenants/${t}/scopes/${s}/backups/restore`, { method: 'POST', headers: auth, body: JSON.stringify({ capturedAt: backup.capturedAt }) });
      expect(res.status).toBe(409);
      expect(w.driver.idsOf(w.object(s))).toHaveLength(1);
      expect(w.driver.stageOf(w.object(s))).toBeUndefined();
    });
  });

  describe('a snapshot copies store to store', () => {
    it('with nothing gathered, and refuses past the request\'s budget with the fork\'s object untouched', async () => {
      const w = world();
      const s = await graphScope();
      w.driver.put(w.object(s), 45);
      const ok = await w.post(`/scopes/${s}/snapshots`, {});
      expect(ok.status, await ok.clone().text()).toBe(201);
      const fork = ((await ok.json()) as { id: ScopeId }).id;
      expect(w.driver.idsOf(w.object(fork))).toHaveLength(45);
      expect(w.driver.held.peak).toBeLessThanOrEqual(10);

      const refused = world({ budget: tight });
      const big = await graphScope();
      refused.driver.put(refused.object(big), 45);
      const res = await refused.post(`/scopes/${big}/snapshots`, {});
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('A backup of this scope');
      expect(refused.driver.callsOf('substrat.commit-stage')).toBe(0);
      expect(refused.driver.callsOf('substrat.discard-stage')).toBeGreaterThan(0);
    });
  });

  describe('a snapshot that fails leaves a fork the sweep can remove (D-69)', () => {
    it('over the budget: its stage goes, its row expires, and it names its version', async () => {
      const w = world({ budget: tight });
      const s = await graphScope();
      w.driver.put(w.object(s), 45);
      const before = (await host.admin.getScopeRecord(staff, t, s))!;
      expect((await w.post(`/scopes/${s}/snapshots`, {})).status).toBe(409);
      const fork = (await host.admin.listScopes(staff, { tenantId: t })).find((row) => row.forkedFrom === s)!;
      expect(fork.expiresAt).not.toBeNull();
      expect(fork.verticalVersionId).toBe(before.verticalVersionId);
      expect(w.driver.stageOf(w.object(fork.id))).toBeUndefined();
      expect(w.driver.calls.some((call) => call.operation === 'substrat.fence' && call.objectName === w.object(fork.id))).toBe(true);
    });

    it('a commit that fails: the same', async () => {
      const w = world();
      const s = await graphScope();
      w.driver.put(w.object(s), 15);
      w.driver.intercept((call) => (call.operation === 'substrat.commit-stage' ? Response.json({ error: { code: 'stage_refused', status: 409 } }) : undefined));
      expect((await w.post(`/scopes/${s}/snapshots`, {})).status).toBe(409);
      const fork = (await host.admin.listScopes(staff, { tenantId: t })).find((row) => row.forkedFrom === s)!;
      expect(fork.expiresAt).not.toBeNull();
      expect(w.driver.stageOf(w.object(fork.id))).toBeUndefined();
    });
  });

  describe('a pull answers one body', () => {
    it('a store too large refuses with 413, naming its size, and masked pulls carry no store at all', async () => {
      const w = world({ pullMax: 2_000 });
      const s = await graphScope();
      w.driver.put(w.object(s), 5_000);
      const full = await w.api.request(`/tenants/${t}/scopes/${s}/export?full=true`, { headers: auth });
      expect(full.status).toBe(413);
      expect(((await full.json()) as { error: string }).error).toMatch(/store 'GRAPH' does not fit in one answer.*No path exports/);
      expect(w.driver.callsOf('substrat.export-page')).toBeLessThan(20);
      const masked = await w.api.request(`/tenants/${t}/scopes/${s}/export`, { headers: auth });
      expect(masked.status).toBe(200);
      expect(((await masked.json()) as ScopeDump).stores).toEqual([]);
    });

    it('a full tenant export spends one budget across its scopes', async () => {
      const own = tenantId.parse(ulid());
      await host.admin.createTenant(staff, { id: own, slug: `pull-${own.toLowerCase()}`, name: 'Pull' });
      const w = world({ pullMax: 2_000 });
      for (let i = 0; i < 2; i += 1) {
        const s = scopeId.parse(ulid());
        await host.provisionScope(staff, { tenantId: own, scopeId: s, vertical: VERTICAL });
        await host.admin.activateScope(staff, own, s);
        const id = ulid();
        await host.admin.publishVersion(staff, {
          id, verticalSlug: VERTICAL, version: `1.0.${id.toLowerCase()}`, manifestDigest: `m-${id}`, permissionDigest: 'p', migrationDigest: 'g',
          deploymentRef: null,
          manifestJson: JSON.stringify({
            version: '1.0.0', entry: 'index.js', compatibilityDate: '2026-07-01',
            registry: { permissions: [], roles: [], entityGrants: [] },
            digests: { manifest: 'm', permission: 'p', migration: 'g' },
            scopeStores: [{ binding: 'GRAPH', driver: 'graph' }],
          }),
        });
        await host.admin.admitVersion(staff, id);
        await host.admin.bindScopeVersion(staff, own, s, id);
        // Each fits the budget alone; together they do not.
        w.driver.put(storeObject(own, VERTICAL, s, 'GRAPH'), 80);
      }
      const res = await w.api.request(`/tenants/${own}/export?full=true`, { headers: auth });
      expect(res.status, await res.clone().text()).toBe(413);
    });
  });
});
