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
  const world = (budget?: StoreRequestBudget) => {
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
    };
    const driver = fakeStoreDriver({ pageRows: 10 });
    const { bucket, objects } = fakeBucket();
    const app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { [VERTICAL]: deployment as unknown as VerticalClient },
      scopeBackups: createR2BackupStore(bucket),
      platformScopeStores: platformOver(driver),
      storeDrivers: [graph],
      ...(budget ? { storeMoveBudget: budget } : {}),
    });
    return { app, driver, deployment, loads, bucket, objects };
  };

  const install = async (): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: VERTICAL });
    await host.admin.activateScope(staff, t, s);
    await host.admin.bindScopeVersion(staff, t, s, versionId);
    return s;
  };

  const store = (s: string, binding: string) => storeObject(t, VERTICAL, s, binding);
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
});
