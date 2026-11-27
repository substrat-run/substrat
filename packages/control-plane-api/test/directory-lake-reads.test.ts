// `node:sqlite` runs the compiled lake SQL for real: `kernel.directory` is table `directory` in a
// database attached as `kernel`, so the WHERE, ORDER and LIMIT under test are SQL, not a mock's.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AdminLogEntry, PlatformActorId } from '@substrat-run/contracts';
import type { AuditLogFilter, HostAdmin } from '@substrat-run/kernel';
import {
  compileDirectoryLakeQuery,
  prunableDirectoryDatasets,
  queryDirectoryLake,
  readAdminLogHistory,
  readWholeAdminLog,
  type DirectoryLakeReads,
} from '../src/directory-lake-reads.js';

const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const OLD = '2026-09-01T00:00:00.000Z'; // before the 35-day window
const NEW = '2026-11-20T00:00:00.000Z'; // inside it
const T1 = '01JTENANT00000000000000001';
const actor = '01JSTAFF000000000000000001' as PlatformActorId;

/** Admin ids are ULID-shaped and time-ordered, so `A0…` sorts before `B0…`. */
const entry = (id: string, at: string, tenantId: string | null = T1, action = 'createTenant'): AdminLogEntry =>
  ({ id, actor, action, tenantId, scopeId: null, vertical: null, before: null, after: { n: id }, causedBy: null, onBehalfOf: null, at }) as AdminLogEntry;

function lakeOf(entries: AdminLogEntry[], extra: Record<string, unknown>[] = []) {
  const db = new DatabaseSync(':memory:');
  db.exec(`ATTACH ':memory:' AS kernel;
    CREATE TABLE kernel.directory (seq INTEGER, dataset TEXT, row_key TEXT, tenant_id TEXT, scope_id TEXT, at TEXT,
      kind TEXT, actor TEXT, captured_at TEXT, row TEXT)`);
  const insert = db.prepare(`INSERT INTO kernel.directory VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let seq = 0;
  for (const e of entries) {
    insert.run(++seq, 'admin_log', e.id, e.tenantId, e.scopeId, e.at, e.action, e.actor, e.at,
      JSON.stringify({ id: e.id, actor: e.actor, action: e.action, tenant_id: e.tenantId, scope_id: e.scopeId, vertical: null,
        before: null, after: JSON.stringify(e.after), caused_by: null, on_behalf_of: null, at: e.at }));
  }
  for (const r of extra) insert.run(...(Object.values(r) as (string | number | null)[]));
  const queries: string[] = [];
  return {
    queries,
    engine: { query: async (sql: string) => (queries.push(sql), db.prepare(sql).all() as Record<string, unknown>[]) },
  };
}

/** `HostAdmin.auditLog` over a list, as the adapters filter it; and the access rows recorded. */
function adminOf(entries: AdminLogEntry[]) {
  const reads: unknown[] = [];
  const admin = {
    auditLog: async (_a: PlatformActorId, f: AuditLogFilter = {}) => {
      const desc = f.order === 'desc';
      let rows = entries
        .filter((e) => (f.tenantId === undefined || e.tenantId === f.tenantId) && (f.since === undefined || e.at >= f.since))
        .filter((e) => (f.until === undefined || e.at < f.until) && (f.cursor === undefined || (desc ? e.id < f.cursor : e.id > f.cursor)))
        .sort((a, b) => (desc ? b.id.localeCompare(a.id) : a.id.localeCompare(b.id)));
      if (f.limit !== undefined) rows = rows.slice(0, f.limit);
      return rows;
    },
    recordDelegatedRead: async (_a: PlatformActorId, r: unknown) => void reads.push(r),
  } as Partial<HostAdmin> as HostAdmin;
  return { admin, reads };
}

const deps = (admin: HostAdmin, lake: { query(sql: string): Promise<readonly Record<string, unknown>[]> }, mode: DirectoryLakeReads, report?: (l: Record<string, unknown>) => void) =>
  ({ admin, actor, lake, mode, nowMs: NOW, ...(report ? { report } : {}) });

describe('the directory lake query (K-70)', () => {
  it('puts the data set and the tenant first, and refuses a literal outside the lake alphabet', () => {
    const sql = compileDirectoryLakeQuery('admin_log', { tenantId: T1, kind: ['a', 'b'], until: NEW, cursor: 'X', order: 'desc', limit: 2 });
    expect(sql).toBe(
      `SELECT seq, dataset, row_key, tenant_id, scope_id, at, kind, actor, captured_at, row FROM kernel.directory ` +
        `WHERE dataset = 'admin_log' AND tenant_id = '${T1}' AND kind IN ('a', 'b') AND at < '${NEW}' AND row_key < 'X' ` +
        `ORDER BY row_key DESC LIMIT 5`,
    );
    expect(() => compileDirectoryLakeQuery('admin_log', { actor: "x' OR 1=1 --", order: 'asc', limit: 1 })).toThrow(/lake alphabet/);
  });

  it('keeps the latest version of each key, and refuses a row of another tenant whole', async () => {
    const { engine } = lakeOf([entry('A1', OLD)], [
      { seq: 9, dataset: 'admin_log', row_key: 'A1', tenant_id: T1, scope_id: null, at: OLD, kind: 'x', actor, captured_at: NEW, row: '{"v":2}' },
    ]);
    expect((await queryDirectoryLake(engine, 'admin_log', { tenantId: T1, order: 'asc', limit: 5 })).records).toEqual([{ rowKey: 'A1', row: { v: 2 } }]);
    const leaky = { query: async () => [{ dataset: 'admin_log', row_key: 'Z', tenant_id: 'OTHER', captured_at: NEW, row: '{}' }] };
    await expect(queryDirectoryLake(leaky, 'admin_log', { tenantId: T1, order: 'asc', limit: 5 })).rejects.toThrow(/outside tenant/);
  });
});

describe('admin log history across the window (K-70)', () => {
  // The directory still holds everything (no prune yet); the lake holds the two old rows.
  const all = [entry('A1', OLD), entry('A2', OLD), entry('B1', NEW), entry('B2', NEW)];

  it('off reads the directory alone, and a read inside the window never asks the lake', async () => {
    const { admin } = adminOf(all);
    const lake = lakeOf(all.slice(0, 2));
    expect((await readAdminLogHistory(deps(admin, lake.engine, 'off'), { limit: 10 })).map((e) => e.id)).toEqual(['A1', 'A2', 'B1', 'B2']);
    await readAdminLogHistory(deps(admin, lake.engine, 'on'), { since: NEW, limit: 10 });
    expect(lake.queries).toEqual([]);
  });

  it('on reads the window from the directory and the rest from the lake, one page crossing the seam either way', async () => {
    // The directory has been pruned to its window; the old rows are the lake's alone.
    const { admin, reads } = adminOf(all.slice(2));
    const lake = lakeOf(all.slice(0, 2));
    const d = deps(admin, lake.engine, 'on');
    const desc = await readAdminLogHistory(d, { tenantId: T1 as never, order: 'desc', limit: 3 });
    expect(desc.map((e) => e.id)).toEqual(['B2', 'B1', 'A2']);
    expect(desc[2]).toMatchObject({ after: { n: 'A2' }, at: OLD });
    expect((await readAdminLogHistory(d, { order: 'desc', cursor: 'A2', limit: 3 })).map((e) => e.id)).toEqual(['A1']);
    expect((await readAdminLogHistory(d, { order: 'asc', limit: 3 })).map((e) => e.id)).toEqual(['A1', 'A2', 'B1']);
    expect((await readWholeAdminLog(d, { tenantId: T1 as never })).map((e) => e.id)).toEqual(['A1', 'A2', 'B1', 'B2']);
    expect(reads[0]).toMatchObject({ method: 'lakeDirectory', tenantId: T1, resultCount: 1, params: { dataset: 'admin_log' } });
  });

  it('compare answers from the directory and reports the rows the lake does not hold', async () => {
    const { admin } = adminOf(all);
    const lake = lakeOf([all[0]!]);
    const reported: Record<string, unknown>[] = [];
    const page = await readAdminLogHistory(deps(admin, lake.engine, 'compare', (l) => reported.push(l)), { limit: 10 });
    expect(page.map((e) => e.id)).toEqual(['A1', 'A2', 'B1', 'B2']);
    expect(reported).toEqual([{ compare: 'admin_log', directory: 2, lake: 1, missing: ['A2'], first: 'A1' }]);
  });
});

describe('which data sets the prune may take (K-70)', () => {
  it('allows only a data set whose history is read from the lake, and only while reads are on', () => {
    expect(prunableDirectoryDatasets(['admin_log', 'ops_failures', 'sweep_runs', 'model_usage', 'access_log'], 'on')).toEqual({
      allowed: ['admin_log', 'ops_failures', 'sweep_runs'],
      refused: [
        { dataset: 'model_usage', reason: 'its history readers do not read the lake yet' },
        { dataset: 'access_log', reason: 'its history readers do not read the lake yet' },
      ],
    });
    expect(prunableDirectoryDatasets(['admin_log'], 'compare')).toEqual({
      allowed: [],
      refused: [{ dataset: 'admin_log', reason: 'DIRECTORY_LAKE_READS is compare, not on' }],
    });
  });
});
