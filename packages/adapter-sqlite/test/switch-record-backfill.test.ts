import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { platformActorId } from '@substrat-run/contracts';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #1674 (Copilot review r4104327527): the switch record's table and its one-time backfill
 * commit together. The backfill runs only on the application that creates the table, so a
 * table left behind by a backfill that failed would be read as "already migrated" on every
 * later start, and the switches pulled before the table existed would never be recorded.
 *
 * The fault is planted in a directory from before the table: its admin log stores the
 * payload under an old column name, so the backfill's read of `after` fails outright. (A
 * NULL in a NOT NULL column would not do: `INSERT OR IGNORE` skips such a row silently.)
 * Renaming the column back is the repair.
 */
describe('the switch record backfill is atomic with its table (#1674)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const T = '01JZ0000000000000000000TNT';
  const S = '01JZ0000000000000000000SCP';
  const plant = (payloadColumn: 'after' | 'payload') => {
    dir = mkdtempSync(join(tmpdir(), 'switch-backfill-'));
    const db = new Database(join(dir, '_directory.sqlite'));
    db.exec(`CREATE TABLE _substrat_admin_log (
      id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, tenant_id TEXT, scope_id TEXT,
      vertical TEXT, before TEXT, ${payloadColumn} TEXT, caused_by TEXT, at TEXT NOT NULL
    )`);
    const row = db.prepare(`INSERT INTO _substrat_admin_log (id, actor, action, tenant_id, scope_id, ${payloadColumn}, at)
      VALUES (?, '01JZ00000000000000000000ST', 'revokeFromSystem', ?, ?, ?, '2026-09-01T00:00:00.000Z')`);
    row.run('01A', T, S, JSON.stringify({ operationId: 'op-1', moduleId: '@m/x', phase: 'intent', reason: 'incident' }));
    row.run('01B', T, S, JSON.stringify({ operationId: 'op-1', moduleId: '@m/x', phase: 'applied' }));
    db.close();
    return dir;
  };
  const tableExists = (d: string) => {
    const db = new Database(join(d, '_directory.sqlite'));
    const found = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_substrat_system_switches'`)
      .get();
    db.close();
    return found !== undefined;
  };

  it('a backfill that fails leaves no table behind, so the next start backfills', async () => {
    const d = plant('payload');
    expect(() => new SqliteScopeHost({ dir: d })).toThrow(/after/);
    expect(tableExists(d)).toBe(false);

    // The log is repaired; the next start sees no table, creates it, and backfills.
    const db = new Database(join(d, '_directory.sqlite'));
    db.exec(`ALTER TABLE _substrat_admin_log RENAME COLUMN payload TO after`);
    db.close();
    const host = new SqliteScopeHost({ dir: d });
    const records = await host.admin.listSystemSwitches(platformActorId.parse('01JZ00000000000000000000ST'));
    expect(records.map((r) => [r.scopeId, r.moduleId, r.position])).toEqual([[S, '@m/x', 'off']]);
    await host.close();
  });

  it('twin: a backfill that succeeds leaves the table, with the row in it', async () => {
    const d = plant('after');
    const host = new SqliteScopeHost({ dir: d });
    const records = await host.admin.listSystemSwitches(platformActorId.parse('01JZ00000000000000000000ST'));
    expect(records.map((r) => r.position)).toEqual(['off']);
    await host.close();
    expect(tableExists(d)).toBe(true);
  });
});

/**
 * #1674 (Copilot review r4104327560): reaping a scope and forgetting its switch records are
 * one directory transaction. Reaped is terminal, so a reap whose cleanup failed AFTER the
 * status flip could never be retried, and the fleet read would list the dead scope's
 * switch for good. The fault: the record table is dropped behind the host's back, so the
 * cleanup throws.
 */
describe('reaping a scope and forgetting its switch records commit together (#1674)', () => {
  it('a reap whose cleanup fails leaves the scope archived, so the reap can be retried', async () => {
    const d = mkdtempSync(join(tmpdir(), 'switch-reap-'));
    try {
      const staff = platformActorId.parse('01JZ00000000000000000000ST');
      const t = '01JZ0000000000000000000TNT' as never;
      const s = '01JZ0000000000000000000SCP' as never;
      let host = new SqliteScopeHost({ dir: d });
      await host.admin.createTenant(staff, { id: t, slug: 'reap', name: 'Reap' });
      await host.provisionScope(staff, { tenantId: t, scopeId: s });
      await host.admin.activateScope(staff, t, s);
      await host.admin.archiveScope(staff, t, s);

      const raw = new Database(join(d, '_directory.sqlite'));
      raw.exec('DROP TABLE _substrat_system_switches');
      raw.close();
      await expect(host.admin.reapScope(staff, t, s, { force: true })).rejects.toThrow(/_substrat_system_switches/);
      expect((await host.admin.getScopeRecord(staff, t, s))?.status).toBe('archived');

      // Restarted, the directory has its table again, and the retried reap completes.
      await host.close();
      host = new SqliteScopeHost({ dir: d });
      await host.admin.reapScope(staff, t, s, { force: true });
      expect((await host.admin.getScopeRecord(staff, t, s))?.status).toBe('reaped');
      await host.close();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
