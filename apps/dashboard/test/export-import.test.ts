import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { MODULES, provisionDashboard, type DashboardNode } from '../src/index.js';
import { exportAppData, restoreAppData, listAppSnapshots } from '../src/provision.js';

/**
 * The Export & import card's backend, embedded mode (preview-and-snapshots.md §8):
 * the check-then-effect helpers the worker's `/export` and `/restore` routes call.
 * Authorization runs in the caller's own dashboard scope (`dashboard/export-app-data`
 * / `dashboard/restore-app-data` gate on dashboard:provision-app); the effect is the
 * platform's exportScope/restoreScope. Connected mode routes the same calls through
 * the tenant-narrowed control plane — that seam is covered by authority.test.ts.
 */
describe('Dashboard export & import — dump out, dump in, safety copy', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let staff = platformActorId.parse(ulid());

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-export-import-'));
    host = new SqliteScopeHost({ dir });
    for (const m of MODULES) host.registerModule(m);
    staff = platformActorId.parse(ulid());
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const makeTeamWithApp = async (): Promise<{ node: DashboardNode; appScope: ReturnType<typeof scopeId.parse> }> => {
    const node = await provisionDashboard(host, {
      tenantId: tenantId.parse(ulid()),
      scopeId: scopeId.parse(ulid()),
      owner: principalId.parse(ulid()),
      slug: 'acme',
      name: 'Acme',
    });
    const appScope = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: node.tenantId, scopeId: appScope, vertical: 'callout' });
    await host.admin.activateScope(staff, node.tenantId, appScope);
    return { node, appScope };
  };

  it('exports the app as a full dump — embedded mode has no trust boundary to mask behind', async () => {
    const { node, appScope } = await makeTeamWithApp();
    const dump = await exportAppData(host, { node, appScopeId: appScope });
    expect(dump.masked).toBe(false);
    expect(dump.tenantId).toBe(node.tenantId);
    expect(dump.scopeId).toBe(appScope);
    // The `_substrat_*` spine travels with the dump — a restore must carry the
    // event/migration state, not just the vertical's tables.
    expect(dump.tables.some((t) => t.name.startsWith('_substrat_'))).toBe(true);
  });

  it('restore replaces the data wholesale — after forking a TTL’d safety copy', async () => {
    const { node, appScope } = await makeTeamWithApp();
    const dump = await exportAppData(host, { node, appScopeId: appScope });
    // A local-world shape: the pulled spine plus a table of the uploader's own.
    const tables = [
      ...dump.tables,
      {
        name: 'imported_notes',
        ddl: 'CREATE TABLE imported_notes (id TEXT PRIMARY KEY, body TEXT)',
        columns: ['id', 'body'],
        rows: [['n1', 'hello from local dev']],
      },
    ];

    const result = await restoreAppData(host, { node, appScopeId: appScope, tables });
    expect(result.restored).toBe(appScope);
    expect(result.tables).toBe(tables.length);

    // The scope now serves the uploaded data…
    const q = await host.admin.queryScope(staff, node.tenantId, appScope, {
      sql: 'SELECT body FROM imported_notes',
    });
    expect(q.rows).toEqual([['hello from local dev']]);

    // …and the pre-restore state survives as the named safety copy, with a TTL.
    const copies = await listAppSnapshots(host, { node, appScopeId: appScope });
    expect(copies).toHaveLength(1);
    expect(copies[0]!.id).toBe(result.safetyCopyId);
    expect(copies[0]!.forkedFrom).toBe(appScope);
    expect(copies[0]!.expiresAt).not.toBeNull();
  });

  it('both halves require app-management authority, before any effect', async () => {
    const { node, appScope } = await makeTeamWithApp();
    const stranger: DashboardNode = { ...node, principal: principalId.parse(ulid()) };

    await expect(exportAppData(host, { node: stranger, appScopeId: appScope })).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      restoreAppData(host, { node: stranger, appScopeId: appScope, tables: [] }),
    ).rejects.toThrow(/permission denied/);
    // The refusal came before the safety fork — nothing was created.
    expect(await listAppSnapshots(host, { node, appScopeId: appScope })).toHaveLength(0);
  });
});
