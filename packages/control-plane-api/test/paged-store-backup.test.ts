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
  type ScopeDumpTable,
  type ScopeId,
  type StoreDriverRegistration,
} from '@substrat-run/contracts';
import {
  ControlPlaneError,
  createControlPlaneApi,
  createR2BackupStore,
  DEV_ACTOR_HEADER,
  UNSAFE_devPlatformActorAuth,
  type VerticalClient,
} from '../src/index.js';
import type { StoreRequestBudget } from '../src/store-move.js';
import { fakeBucket } from './fake-r2-bucket.js';
import { fakeStoreDriver, platformOver, storeObject } from './helpers/store-fakes.js';

/**
 * A backup, a restore and a snapshot hold one page of a scope store at a time (D-69). A backup
 * writes each store's pages as `store-page` entries under its manifest's `storeEntries`; a restore
 * stages every store, loads the scope, commits the stores and replays erasures, in that order; a
 * snapshot stages the fork's stores straight from the source's. The driver cuts a page at 10 rows,
 * so a store of 25 rows takes three.
 */
describe('scope stores in pages through a backup, a restore and a snapshot (D-69)', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const VERTICAL = 'docs';
  const graph: StoreDriverRegistration = { driver: 'graph', isolationBasis: { kind: 'writtenInRepo' }, dumpPageMaxBytes: 900_000 };
  const customers: ScopeDumpTable = { name: 'customers', ddl: 'CREATE TABLE customers (id TEXT)', columns: ['id'], rows: [['c1']] };
  let dir: string;
  let host: SqliteScopeHost;
  let versionId: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-paged-stores-'));
    host = new SqliteScopeHost({ dir });
    await host.admin.createTenant(staff, { id: t, slug: 'paged-stores-co', name: 'Paged Stores Co' });
    await host.admin.registerVertical(staff, { slug: VERTICAL, name: VERTICAL, source: 'cli' });
    versionId = ulid();
    await host.admin.publishVersion(staff, {
      id: versionId,
      verticalSlug: VERTICAL,
      version: `1.0.${versionId.toLowerCase()}`,
      manifestDigest: `m-${versionId}`,
      permissionDigest: 'p',
      migrationDigest: 'g',
      deploymentRef: `${VERTICAL}-${versionId.toLowerCase()}`,
      manifestJson: JSON.stringify({
        version: '1.0.0',
        entry: 'index.js',
        compatibilityDate: '2026-07-01',
        registry: { permissions: [], roles: [], entityGrants: [] },
        digests: { manifest: 'm', permission: 'p', migration: 'g' },
        scopeStores: [{ binding: 'DOCS', driver: 'graph' }, { binding: 'GRAPH', driver: 'graph' }],
      }),
    });
    await host.admin.admitVersion(staff, versionId);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** What the deployment was asked to load, and a switch to make its load refuse. */
  const world = (budget?: StoreRequestBudget, opts: { backups?: boolean } = {}) => {
    const loads: unknown[] = [];
    const deployment = {
      refuseLoad: false,
      exportScopePage: async () => ({ tables: [customers], next: null, loadStamp: null, revision: 'r0' }),
      exportScopeChanges: async () => ({ tables: [], final: true, revision: 'r0' }),
      endScopeCapture: async () => undefined,
      stageScopePage: async () => ({ staged: true }),
      stageScopeChanges: async () => ({ staged: true }),
      discardStagedScope: async () => undefined,
      restoreScope: async (_t: string, _s: string, tables: unknown) => {
        if (deployment.refuseLoad) throw new Error('the deployment refused the load');
        loads.push(tables);
        return { tables: 1 };
      },
      snapshotScope: async () => ({ tables: 1 }),
      deleteScope: async () => undefined,
      exportScope: async () => [customers],
    };
    const driver = fakeStoreDriver({ pageRows: 10 });
    const { bucket, objects } = fakeBucket();
    const app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { [VERTICAL]: deployment as unknown as VerticalClient },
      ...(opts.backups === false ? {} : { scopeBackups: createR2BackupStore(bucket) }),
      platformScopeStores: platformOver(driver),
      storeDrivers: [graph],
      ...(budget ? { storeMoveBudget: budget } : {}),
    });
    return { app, driver, deployment, loads, bucket, objects };
  };

  const install = async (tenant = t): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: tenant, scopeId: s, vertical: VERTICAL });
    await host.admin.activateScope(staff, tenant, s);
    await host.admin.bindScopeVersion(staff, tenant, s, versionId);
    return s;
  };

  const store = (s: string, binding: string, tenant = t) => storeObject(tenant, VERTICAL, s, binding);
  const ops = (w: ReturnType<typeof world>) => w.driver.calls.map((c) => c.operation);

  /** A scope whose GRAPH store holds 25 rows and DOCS 3, and a backup of it. */
  const backedUp = async (w: ReturnType<typeof world>) => {
    const s = await install();
    w.driver.put(store(s, 'GRAPH'), 25);
    w.driver.put(store(s, 'DOCS'), 3);
    const taken = await w.app.request(`/tenants/${t}/scopes/${s}/backups`, { method: 'POST', headers: auth });
    expect(taken.status).toBe(201);
    return { s, backup: (await taken.json()) as ScopeBackup };
  };
  const restore = (w: ReturnType<typeof world>, s: string, capturedAt: string) =>
    w.app.request(`/tenants/${t}/scopes/${s}/backups/${capturedAt}/restore`, { method: 'POST', headers: auth });

  it('a backup holds each store as store-page entries its manifest names, and restores them: staged, loaded, then committed', async () => {
    const w = world();
    const { s, backup } = await backedUp(w);
    const manifest = JSON.parse(w.objects.get(`scopes/${t}/${s}/${backup.capturedAt}.json`)!.body) as {
      stores: unknown[];
      storeEntries: { binding: string; driver: string; stageId: string; entries: number; revision: string }[];
    };
    expect(manifest.stores).toEqual([]);
    expect(manifest.storeEntries.map((e) => [e.binding, e.driver, e.entries])).toEqual([['DOCS', 'graph', 1], ['GRAPH', 'graph', 3]]);
    const graphPages = [...w.objects.keys()].filter((key) => key.includes(`/${manifest.storeEntries[1]!.stageId}/`));
    expect(graphPages).toHaveLength(3);
    expect(JSON.parse(w.objects.get(graphPages[0]!)!.body)).toMatchObject({ kind: 'store-page' });

    // GRAPH spans three pages, so only a restore applies the backup.
    expect((await w.app.request(`/tenants/${t}/scopes/${s}/backups/${backup.capturedAt}`, { headers: auth })).status).toBe(413);

    w.driver.put(store(s, 'GRAPH'), 1);
    w.driver.calls.length = 0;
    const loaded = w.loads.length;
    const restored = await restore(w, s, backup.capturedAt);
    expect(restored.status).toBe(200);
    expect(w.loads.length).toBe(loaded + 1);
    expect(w.driver.idsOf(store(s, 'GRAPH'))).toHaveLength(25);
    expect(w.driver.idsOf(store(s, 'DOCS'))).toHaveLength(3);
    // Every page staged before the first commit.
    const firstCommit = ops(w).indexOf('substrat.commit-stage');
    expect(ops(w).slice(0, firstCommit).filter((op) => op === 'substrat.stage-page')).toHaveLength(4);
    expect(ops(w).slice(firstCommit)).toEqual(['substrat.commit-stage', 'substrat.commit-stage']);
  });

  it('serves a backup whose stores fit one page each whole, its stores inline', async () => {
    const w = world();
    const s = await install();
    w.driver.put(store(s, 'GRAPH'), 4);
    const taken = (await (await w.app.request(`/tenants/${t}/scopes/${s}/backups`, { method: 'POST', headers: auth })).json()) as ScopeBackup;
    const whole = await w.app.request(`/tenants/${t}/scopes/${s}/backups/${taken.capturedAt}`, { headers: auth });
    expect(whole.status).toBe(200);
    const dump = (await whole.json()) as { stores: { binding: string; tables: ScopeDumpTable[] }[] };
    expect(dump.stores.map((x) => [x.binding, x.tables.flatMap((tb) => tb.rows).length])).toEqual([['DOCS', 0], ['GRAPH', 4]]);
  });

  it.each([
    ['missing', (w: ReturnType<typeof world>, key: string) => w.objects.delete(key)],
    ['of the wrong kind', (w: ReturnType<typeof world>, key: string) => w.objects.set(key, { key, body: JSON.stringify({ kind: 'page', tables: [] }) })],
  ])('refuses a backup whose store page is %s before anything changes', async (_, damage) => {
    const w = world();
    const { s, backup } = await backedUp(w);
    const manifest = JSON.parse(w.objects.get(`scopes/${t}/${s}/${backup.capturedAt}.json`)!.body) as { storeEntries: { stageId: string }[] };
    damage(w, `scopes/${t}/${s}/${backup.capturedAt}/${manifest.storeEntries[1]!.stageId}/2.json`);
    w.driver.put(store(s, 'GRAPH'), 1);
    const loaded = w.loads.length;
    const refused = await restore(w, s, backup.capturedAt);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(w.loads.length).toBe(loaded);
    expect(ops(w)).not.toContain('substrat.commit-stage');
    expect(w.driver.idsOf(store(s, 'GRAPH'))).toHaveLength(1);
    expect(w.driver.stageOf(store(s, 'DOCS'))).toBeUndefined();
  });

  it("discards every store's stage when the deployment refuses the load, so no store changes", async () => {
    const w = world();
    const { s, backup } = await backedUp(w);
    w.driver.put(store(s, 'GRAPH'), 1);
    w.deployment.refuseLoad = true;
    const refused = await restore(w, s, backup.capturedAt);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(ops(w)).not.toContain('substrat.commit-stage');
    expect(w.driver.idsOf(store(s, 'GRAPH'))).toHaveLength(1);
    expect(w.driver.stageOf(store(s, 'GRAPH'))).toBeUndefined();
    expect(w.driver.stageOf(store(s, 'DOCS'))).toBeUndefined();
  });

  it('a commit that fails part-way still replays erasures and names what was committed; the same restore again converges', async () => {
    const w = world();
    const { s, backup } = await backedUp(w);
    w.driver.put(store(s, 'GRAPH'), 1);
    await host.admin.shredSubject(staff, t, s, ulid());
    w.driver.intercept((call) =>
      call.operation === 'substrat.commit-stage' && call.objectName === store(s, 'GRAPH')
        ? Response.json({ error: { code: 'stage_refused', status: 409 } })
        : undefined,
    );
    const half = await restore(w, s, backup.capturedAt);
    expect(half.status).toBe(409);
    expect(JSON.stringify(await half.json())).toMatch(/DOCS committed, GRAPH not known to be; restore again/);
    expect(w.driver.callsOf('substrat.erase')).toBe(2);
    expect(w.driver.idsOf(store(s, 'GRAPH'))).toHaveLength(1);

    w.driver.intercept(undefined);
    expect((await restore(w, s, backup.capturedAt)).status).toBe(200);
    expect(w.driver.idsOf(store(s, 'GRAPH'))).toHaveLength(25);
  });

  it('restores a backup written with its stores inline, through the same stages', async () => {
    const w = world();
    const s = await install();
    const capturedAt = '2026-10-01T00:00:00.000Z';
    const nodes = { name: 'nodes', ddl: 'graph nodes', columns: ['id', 'pad'], rows: Array.from({ length: 12 }, (_, i) => [`n${i}`, 'x']) };
    // A manifest as #2839 wrote it: no `storeEntries`, the stores in the header.
    const stageId = ulid();
    await w.bucket.put(`scopes/${t}/${s}/${capturedAt}/${stageId}/0.json`, JSON.stringify({ kind: 'page', tables: [customers] }));
    await w.bucket.put(`scopes/${t}/${s}/${capturedAt}.json`, JSON.stringify({
      tenantId: t, scopeId: s, capturedAt, format: 'paged', stageId, entries: 1, tables: 1,
      stores: [{ binding: 'GRAPH', driver: 'graph', tables: [nodes] }],
    }));
    expect((await restore(w, s, capturedAt)).status).toBe(200);
    expect(w.driver.idsOf(store(s, 'GRAPH'))).toHaveLength(12);
    expect(ops(w).filter((op) => op === 'substrat.commit-stage')).toHaveLength(1);
  });

  it("a snapshot stages the fork's stores from the source's and commits them; past its budget it refuses with none committed", async () => {
    const w = world();
    const s = await install();
    w.driver.put(store(s, 'GRAPH'), 25);
    const snap = await w.app.request(`/tenants/${t}/scopes/${s}/snapshots`, { method: 'POST', headers: auth, body: '{}' });
    expect(snap.status).toBe(201);
    const { id: fork } = (await snap.json()) as { id: string };
    expect(w.driver.idsOf(store(fork, 'GRAPH'))).toEqual(w.driver.idsOf(store(s, 'GRAPH')));

    const tight = world({ pages: 2, ms: 60_000, sleep: async () => undefined });
    tight.driver.put(store(s, 'GRAPH'), 25);
    const refused = await tight.app.request(`/tenants/${t}/scopes/${s}/snapshots`, { method: 'POST', headers: auth, body: '{}' });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(await refused.json())).toMatch(/budget of 2 pages/);
    expect(ops(tight)).not.toContain('substrat.commit-stage');
  });

  it('a scope a reap has marked takes no restore on either route, before anything is staged or loaded (D-71)', async () => {
    const w = world();
    const { s, backup } = await backedUp(w);
    await host.admin.archiveScope(staff, t, s);
    await host.admin.markScopeStoresFenced(staff, t, s);
    w.driver.calls.length = 0;
    const loaded = w.loads.length;
    const dump = { tenantId: t, scopeId: s, capturedAt: '2026-01-02T03:04:05.000Z', tables: [customers] };
    for (const res of [
      await restore(w, s, backup.capturedAt),
      await w.app.request(`/tenants/${t}/scopes/${s}/restore`, { method: 'POST', headers: auth, body: JSON.stringify(dump) }),
    ]) {
      expect(res.status).toBe(409);
      expect(JSON.stringify(await res.json())).toContain('a new scope');
    }
    expect(w.driver.calls).toEqual([]);
    expect(w.loads.length).toBe(loaded);
  });

  it('a reap that fences the stores while a restore runs leaves them empty: the commits are refused (D-71)', async () => {
    const w = world();
    const { s, backup } = await backedUp(w);
    await host.admin.archiveScope(staff, t, s);
    let fenced = false;
    w.driver.before(async (call) => {
      if (call.operation !== 'substrat.commit-stage' || fenced) return;
      fenced = true;
      await platformOver(w.driver).fenceStores({
        tenantId: t, scopeId: s, vertical: VERTICAL, stores: [{ binding: 'DOCS', driver: 'graph' }, { binding: 'GRAPH', driver: 'graph' }],
      });
    });
    const res = await restore(w, s, backup.capturedAt);
    expect(fenced).toBe(true);
    expect(res.status).toBe(410);
    const answer = JSON.stringify(await res.json());
    expect(answer).toContain('store_fenced');
    expect(answer).toContain('restores into a new scope');
    expect(answer).not.toContain('restore again to finish');
    expect(w.driver.rowsOf(store(s, 'GRAPH'))).toBe(0);
    expect(w.driver.rowsOf(store(s, 'DOCS'))).toBe(0);
  });

  it('a marked scope is not read for a copy: a backup, a fork and a full pull refuse, naming the way out (D-71)', async () => {
    const w = world();
    const { s } = await backedUp(w);
    await host.admin.archiveScope(staff, t, s);
    await host.admin.markScopeStoresFenced(staff, t, s);
    w.driver.calls.length = 0;
    for (const res of [
      await w.app.request(`/tenants/${t}/scopes/${s}/backups`, { method: 'POST', headers: auth }),
      await w.app.request(`/tenants/${t}/scopes/${s}/snapshots`, { method: 'POST', headers: auth, body: '{}' }),
      await w.app.request(`/tenants/${t}/scopes/${s}/export?full=true`, { headers: auth }),
    ]) {
      expect(res.status).toBe(409);
      expect(JSON.stringify(await res.json())).toContain('a new scope');
    }
    expect(ops(w)).not.toContain('substrat.export-page');
  });

  it('a reap asked again on a scope its first try marked takes no new backup, and finishes with backup=false (D-71)', async () => {
    const w = world();
    const { s, backup } = await backedUp(w);
    await host.admin.archiveScope(staff, t, s);
    // The first try took its backup and marked the scope, then failed before the row was reaped.
    await host.admin.markScopeStoresFenced(staff, t, s);
    const reap = (body: unknown) =>
      w.app.request(`/tenants/${t}/scopes/${s}/reap`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    const before = [...w.objects.keys()].filter((k) => k.startsWith(`scopes/${t}/${s}/`)).length;
    const again = await reap({});
    expect(again.status).toBe(409);
    const refusal = JSON.stringify(await again.json());
    expect(refusal).toContain('backup=false');
    expect(refusal).toContain(`/scopes/${s}/backups`);
    expect([...w.objects.keys()].filter((k) => k.startsWith(`scopes/${t}/${s}/`)).length).toBe(before);
    expect((await reap({ backup: false })).status).toBe(200);
    expect((await host.admin.getScopeRecord(staff, t, s))?.status).toBe('reaped');
    expect(w.objects.has(`scopes/${t}/${s}/${backup.capturedAt}.json`)).toBe(true);
  });

  it('a scope reap asked again with no backup asked for and no backup target goes on (D-71)', async () => {
    const w = world(undefined, { backups: false });
    const s = await install();
    w.driver.put(store(s, 'GRAPH'), 3);
    await host.admin.archiveScope(staff, t, s);
    await host.admin.markScopeStoresFenced(staff, t, s);
    const res = await w.app.request(`/tenants/${t}/scopes/${s}/reap`, { method: 'POST', headers: auth, body: '{}' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await host.admin.getScopeRecord(staff, t, s))?.status).toBe('reaped');
  });

  it('a tenant reap with backup asked again after it failed partway backs up the rest and skips the marked scope (D-71)', async () => {
    const w = world();
    const tenant = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: tenant, slug: `reap-${tenant.slice(-8).toLowerCase()}`, name: 'Reap Co' });
    const scopes = [await install(tenant), await install(tenant)];
    for (const s of scopes) w.driver.put(store(s, 'GRAPH', tenant), 3);
    await host.admin.setTenantStatus(staff, tenant, 'deleting');
    // The first scope the reap reaches fails after its backup and its fence: the try stops there.
    let failed: string | undefined;
    const deleteScope = async (_t: string, s: string) => {
      if (failed === undefined) {
        failed = s;
        throw new ControlPlaneError(503, 'the deployment could not delete the scope');
      }
    };
    (w.deployment as unknown as { deleteScope: unknown }).deleteScope = ({ scopeId: s }: { scopeId: string }) => deleteScope(tenant, s);
    const reap = () => w.app.request(`/tenants/${tenant}/reap`, { method: 'POST', headers: auth, body: JSON.stringify({ backup: true }) });
    expect((await reap()).status).toBe(503);
    expect(await host.admin.scopeStoresFencedAt(staff, tenant, scopeId.parse(failed!))).not.toBeNull();
    const backupsOf = (s: string) => [...w.objects.keys()].filter((k) => k.startsWith(`scopes/${tenant}/${s}/`) && /\.json$/.test(k) && !k.slice(`scopes/${tenant}/${s}/`.length).includes('/')).length;
    expect(backupsOf(failed!)).toBe(1);
    const again = await reap();
    expect(again.status, await again.clone().text()).toBe(200);
    // The marked scope keeps the one backup its first try took; the other got its own.
    for (const s of scopes) expect(backupsOf(s)).toBe(1);
    expect((await host.admin.getTenant(staff, tenant))?.status).toBe('reaped');
  });
});
