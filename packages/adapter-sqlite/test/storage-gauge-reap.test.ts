import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #1524: reap and fork delete DELETE a scope's storage samples and its attempt row. Every read of either
 * also joins on scope status, so the shared contract suite cannot see whether the rows are
 * gone or only hidden; this reads the directory tables themselves.
 */
describe('storage gauge rows at reap (#1524)', () => {
  it('measures a legacy archived row whose archived_from_status is NULL, as before the column existed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-gauge-legacy-'));
    dirs.push(dir);
    const host = new SqliteScopeHost({ dir });
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'gauge-legacy', name: 'Gauge Legacy' });
    // Archived from provisioning, then made a legacy row: the column was never written.
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s });
    await host.admin.archiveScope(staff, t, s);
    const directory = (host as unknown as { directory: { prepare(q: string): { run(...a: unknown[]): void } } }).directory;
    directory.prepare('UPDATE scopes SET archived_from_status = NULL WHERE scope_id = ?').run(s);

    expect(await host.admin.recordScopeStorage!(staff, [{ tenantId: t, scopeId: s, bytes: 5, readAt: new Date().toISOString() }])).toEqual({
      recorded: 1,
    });
    expect((await host.admin.readMeters(staff, { tenantId: t })).perTenant[0]!.storage).toMatchObject({ bytes: 5, sampled: 1, total: 1 });
    await host.close();
  });

  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("deletes a reaped scope's and a deleted fork's samples and attempt, and keeps its sibling's", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-gauge-reap-'));
    dirs.push(dir);
    const host = new SqliteScopeHost({ dir });
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'gauge-reap', name: 'Gauge Reap' });
    const [kept, reaped] = [scopeId.parse(ulid()), scopeId.parse(ulid())];
    for (const s of [kept, reaped]) {
      await host.provisionScope(staff, { tenantId: t, scopeId: s });
      await host.admin.activateScope(staff, t, s);
    }
    const now = new Date().toISOString();
    await host.admin.recordScopeStorage!(staff, [
      { tenantId: t, scopeId: kept, bytes: 1, readAt: now },
      { tenantId: t, scopeId: reaped, bytes: 2, readAt: now },
    ]);
    const directory = (host as unknown as { directory: { prepare(q: string): { get(...a: unknown[]): unknown } } }).directory;
    const count = (table: string, scope: string) =>
      (directory.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE scope_id = ?`).get(scope) as { n: number }).n;
    expect([count('_substrat_scope_storage', reaped), count('_substrat_scope_storage_attempts', reaped)]).toEqual([1, 1]);

    await host.admin.archiveScope(staff, t, reaped);
    await host.admin.reapScope(staff, t, reaped);

    expect([count('_substrat_scope_storage', reaped), count('_substrat_scope_storage_attempts', reaped)]).toEqual([0, 0]);
    expect([count('_substrat_scope_storage', kept), count('_substrat_scope_storage_attempts', kept)]).toEqual([1, 1]);

    // Fork delete (`deleteSnapshot`) removes the directory row itself, so the rows it leaves
    // behind would be invisible to every joined read, and the attempt row has no retention.
    const fork = await host.snapshotScope(staff, t, kept);
    await host.admin.recordScopeStorage!(staff, [{ tenantId: t, scopeId: fork, bytes: 3, readAt: now }]);
    expect([count('_substrat_scope_storage', fork), count('_substrat_scope_storage_attempts', fork)]).toEqual([1, 1]);
    await host.deleteSnapshot(staff, t, fork);
    expect([count('_substrat_scope_storage', fork), count('_substrat_scope_storage_attempts', fork)]).toEqual([0, 0]);
    await host.close();
  });
});
