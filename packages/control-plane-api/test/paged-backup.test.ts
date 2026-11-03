import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import {
  dataSubjectId,
  platformActorId,
  scopeId,
  tenantId,
  type ScopeBackup,
  type ScopeDumpTable,
  type ScopeId,
} from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  createR2BackupStore,
  mintTenantToken,
  tenantTokenAuth,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth,
  type VerticalClient,
} from '../src/index.js';
import { fakeBucket } from './fake-r2-bucket.js';

/**
 * A scope backup of any size (#2839). The backup moves out of the deployment a page at a time,
 * as a paged copy does (#2450), each page and each batch of writes caught meanwhile stored as one
 * sealed entry under a manifest written last; its restore stages the entries back at the
 * deployment, which loads the stage. A deployment here serves two pages and one change batch, so
 * every kind of entry is written and read.
 */
describe('paged scope backups (#2839)', () => {
  const TENANT_SECRET = 'paged-backup-tenant-token-secret';
  const staff = platformActorId.parse(ulid());
  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const t = tenantId.parse(ulid());
  const other = tenantId.parse(ulid());
  const subject = dataSubjectId.parse(ulid());
  let dir: string;
  let host: SqliteScopeHost;

  const OUTBOX = {
    name: '_substrat_outbox',
    ddl: 'CREATE TABLE _substrat_outbox (id TEXT, subject_id TEXT, pii_class TEXT, payload TEXT)',
    columns: ['id', 'subject_id', 'pii_class', 'payload'],
  };
  const customers: ScopeDumpTable = {
    name: 'customers',
    ddl: 'CREATE TABLE customers (id TEXT)',
    columns: ['id'],
    rows: [['c1']],
  };
  const pageSecret = JSON.stringify({ secret: 'page-personal-data' });
  const changeSecret = JSON.stringify({ secret: 'change-personal-data' });

  /** What the deployment was asked to stage, discard, load and wipe. */
  type Calls = { staged: { kind: string; seq: number; stageId: string; tables: ScopeDumpTable[] }[]; discarded: string[]; restored: unknown[]; wiped: string[] };
  const deployment = (calls: Calls) => ({
    exportScopePage: async (_s: ScopeId, cursor: string | null, opts: { capture?: string }) => cursor === null
      ? { tables: [customers], next: 'p1', loadStamp: null, revision: 'r0', ...(opts.capture ? { captured: true } : {}) }
      : { tables: [{ ...OUTBOX, rows: [['e1', subject, 'direct', pageSecret]], rowids: [1] }], next: null, loadStamp: null, revision: 'r0' },
    exportScopeChanges: async () => ({
      tables: [{ ...OUTBOX, rows: [['e2', subject, 'direct', changeSecret]], rowids: [2], deleted: [] }],
      final: true,
      revision: 'r1',
    }),
    endScopeCapture: async () => undefined,
    stageScopePage: async (_s: ScopeId, stageId: string, seq: number, tables: ScopeDumpTable[]) => {
      calls.staged.push({ kind: 'page', seq, stageId, tables });
      return { staged: true };
    },
    stageScopeChanges: async (_s: ScopeId, stageId: string, seq: number, tables: ScopeDumpTable[]) => {
      calls.staged.push({ kind: 'changes', seq, stageId, tables });
      return { staged: true };
    },
    discardStagedScope: async (_s: ScopeId, stageId: string) => {
      calls.discarded.push(stageId);
    },
    restoreScope: async (_t: string, _s: string, tables: unknown) => {
      calls.restored.push(tables);
      return { tables: 2 };
    },
    deleteScope: async (input: { scopeId: string }) => {
      calls.wiped.push(input.scopeId);
    },
  }) as unknown as VerticalClient;

  const world = (opts: { failOn?: (key: string) => boolean } = {}) => {
    const calls: Calls = { staged: [], discarded: [], restored: [], wiped: [] };
    const { bucket, objects } = fakeBucket(100, opts);
    const store = createR2BackupStore(bucket);
    const app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(TENANT_SECRET, staff),
      verticals: { 'demo-vert': deployment(calls) },
      scopeBackups: store,
    });
    return { app, calls, objects, store, bucket };
  };

  const install = async (): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'demo-vert' });
    await host.admin.activateScope(staff, t, s);
    return s;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-paged-backup-'));
    // A SecretBox, so a backup can be sealed per subject (#37).
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
    await host.admin.createTenant(staff, { id: t, slug: 'paged-co', name: 'Paged Co' });
    await host.admin.createTenant(staff, { id: other, slug: 'other-co', name: 'Other Co' });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores every page and change batch as a sealed entry, and restores them through the deployment\'s stage', async () => {
    const { app, calls, objects } = world();
    const s = await install();
    const taken = await app.request(`/tenants/${t}/scopes/${s}/backups`, { method: 'POST', headers: asStaff });
    expect(taken.status).toBe(201);
    const backup = (await taken.json()) as ScopeBackup;
    expect(backup).toMatchObject({ scopeId: s, tables: 2 });

    // A manifest and three entries: two pages, then the batch the capture caught.
    const entries = [...objects.values()].filter((o) => o.key.split('/').length === 6);
    expect(entries.map((o) => (JSON.parse(o.body) as { kind: string }).kind).sort()).toEqual(['changes', 'page', 'page']);
    // Sealed in a change batch exactly as in a page (#37): no classified payload is at rest in plaintext.
    const atRest = [...objects.values()].map((o) => o.body).join('\n');
    expect(atRest).not.toContain('page-personal-data');
    expect(atRest).not.toContain('change-personal-data');
    expect(entries.every((o) => o.body.includes('__sealed') || !o.body.includes('_substrat_outbox'))).toBe(true);

    // Too large to answer whole, so the GET names the restore that loads it.
    const whole = await app.request(`/tenants/${t}/scopes/${s}/backups/${backup.capturedAt}`, { headers: asStaff });
    expect(whole.status).toBe(413);

    const restored = await app.request(`/tenants/${t}/scopes/${s}/backups/${backup.capturedAt}/restore`, { method: 'POST', headers: asStaff });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ restored: s, tables: 2 });
    // Staged in order under one stage, opened again, and the deployment loaded that stage.
    const stage = calls.staged.at(-1)!.stageId;
    const back = calls.staged.filter((x) => x.stageId === stage);
    expect(back.map((x) => [x.kind, x.seq])).toEqual([['page', 0], ['page', 1], ['changes', 2]]);
    expect(JSON.stringify(back)).toContain('page-personal-data');
    expect(JSON.stringify(back)).toContain('change-personal-data');
    expect(calls.restored).toEqual([{ stageId: stage }]);
    // The same audited restore `POST …/restore` writes.
    const log = await host.admin.auditLog(staff, { tenantId: t, limit: 50 });
    expect(log.some((e) => e.action === 'restoreScope' && e.scopeId === s)).toBe(true);
  });

  it('serves and restores a backup stored whole before #2839 as the dump it is', async () => {
    const { app, calls, bucket } = world();
    const s = await install();
    const capturedAt = '2026-07-01T00:00:00.000Z';
    await bucket.put(`scopes/${t}/${s}/${capturedAt}.json`, JSON.stringify({ tenantId: t, scopeId: s, capturedAt, tables: [customers], stores: [] }));

    const whole = await app.request(`/tenants/${t}/scopes/${s}/backups/${capturedAt}`, { headers: asStaff });
    expect(whole.status).toBe(200);
    expect(await whole.json()).toMatchObject({ scopeId: s, tables: [customers] });

    const restored = await app.request(`/tenants/${t}/scopes/${s}/backups/${capturedAt}/restore`, { method: 'POST', headers: asStaff });
    expect(restored.status).toBe(200);
    // Loaded whole, as an uploaded dump is: nothing staged.
    expect(calls.staged).toEqual([]);
    expect(calls.restored).toEqual([[customers]]);
  });

  it('refuses the reap when the manifest does not land, and leaves no backup and no entries behind', async () => {
    const manifest = (key: string) => key.split('/').length === 4;
    const { app, calls, objects, store } = world({ failOn: manifest });
    const s = await install();
    await host.admin.archiveScope(staff, t, s);

    const reap = await app.request(`/tenants/${t}/scopes/${s}/reap`, { method: 'POST', headers: asStaff, body: JSON.stringify({ backup: true }) });
    expect(reap.status).toBe(502);
    expect(((await reap.json()) as { error: string }).error).toMatch(/the scope was NOT reaped/);
    expect(calls.wiped).toEqual([]);
    expect((await host.admin.getScopeRecord(staff, t, s))!.status).toBe('archived');
    expect(await store.list({ tenantId: t, scopeId: s })).toEqual([]);
    expect(objects.size).toBe(0);
  });

  it('refuses a caller on the backup restore that `POST …/restore` refuses', async () => {
    const { app, calls, bucket } = world();
    const s = await install();
    const capturedAt = '2026-07-02T00:00:00.000Z';
    const dump = { tenantId: t, scopeId: s, capturedAt, tables: [customers], stores: [] };
    await bucket.put(`scopes/${t}/${s}/${capturedAt}.json`, JSON.stringify(dump));
    // Another tenant's credential, for this tenant's scope.
    const asOther = { [SERVICE_TOKEN_HEADER]: await mintTenantToken(TENANT_SECRET, { tenantId: other }), 'content-type': 'application/json' };

    const upload = await app.request(`/tenants/${t}/scopes/${s}/restore`, { method: 'POST', headers: asOther, body: JSON.stringify(dump) });
    const held = await app.request(`/tenants/${t}/scopes/${s}/backups/${capturedAt}/restore`, { method: 'POST', headers: asOther });
    expect(upload.status).toBe(403);
    expect(held.status).toBe(upload.status);
    expect(calls.restored).toEqual([]);
  });
});
