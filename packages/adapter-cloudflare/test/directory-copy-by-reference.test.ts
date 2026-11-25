import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import {
  mergeDumpPages,
  type DirectoryCopyByReference,
  type DirectoryDumpPage,
  type ScopeDumpTable,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { DIRECTORY_COPY_BY_REFERENCE } from '../src/directory-copy-reference.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #3325: the daily directory copy reads its append-only and log tables by reference, up to the
 * rowid each held at the first page, instead of copying them into a snapshot inside the directory.
 * Every case runs on a directory DO of its own, so no other file's writes are in it.
 */
interface Directory {
  exportDump(): Promise<ScopeDumpTable[]>;
  exportDumpPage(
    cursor: string | null,
    opts?: { maxBytes?: number; byReference?: DirectoryCopyByReference },
  ): Promise<DirectoryDumpPage>;
  importDump(tables: ScopeDumpTable[]): Promise<void>;
  createTenant(id: string, slug: string, name: string, createdAt: string, by: null, audit: unknown): Promise<unknown>;
  listTenants(): Promise<{ id: string }[]>;
  recordAccess(entry: unknown): Promise<void>;
  markAccessLogDrained(upToId: string, drainedAt: string): Promise<number>;
  pruneAccessLog(limit: number): Promise<number>;
}

declare global {
  interface ImportMeta {
    glob(pattern: string, options: { query: string; import: string; eager: true }): Record<string, string>;
  }
}

const AT = '2026-11-25T00:00:00.000Z';
const PAGE = { maxBytes: 300 };

function open(): { dir: Directory; stub: DurableObjectStub } {
  const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`copy-by-ref-${ulid()}`));
  return { dir: stub as unknown as Directory, stub };
}

async function addTenant(dir: Directory, n: string): Promise<void> {
  const audit = {
    id: `adm-${n}`, actor: 'act_test', action: 'createTenant', tenantId: `t-${n}`,
    scopeId: null, vertical: null, before: null, after: { slug: `s-${n}` }, at: AT,
  };
  await dir.createTenant(`t-${n}`, `s-${n}`, `Tenant ${n}`, AT, null, audit);
}

const addAccess = (dir: Directory, n: string) =>
  dir.recordAccess({ id: `acc-${n}`, actor: 'act_test', method: 'listTenants', tenantId: null, scopeId: null, params: null, resultCount: 1, at: AT });

/** Six tenants (each with its admin-log row) and six access-log rows. */
async function seeded(): Promise<{ dir: Directory; stub: DurableObjectStub }> {
  const opened = open();
  for (let i = 0; i < 6; i++) {
    await addTenant(opened.dir, String(i));
    await addAccess(opened.dir, String(i));
  }
  return opened;
}

/** A whole copy: the first page, `between` while it is open, then every page after it. */
async function copy(dir: Directory, mode: DirectoryCopyByReference, between: () => Promise<void>, maxBytes = PAGE.maxBytes) {
  const pages = [await dir.exportDumpPage(null, { maxBytes, byReference: mode })];
  await between();
  while (pages.at(-1)!.next !== null) pages.push(await dir.exportDumpPage(pages.at(-1)!.next, { maxBytes }));
  return pages;
}

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

it('reads the by-reference tables as they stood at the first page, writes no copy of them, and restores into a working directory', async () => {
  const { dir, stub } = await seeded();
  const whole = await dir.exportDump();

  const pages = await copy(dir, 'on', async () => {
    // What the first page wrote: a snapshot of every table except the by-reference ones.
    const snapshot = await runInDurableObject(stub, (_i, state) => ({
      referenced: state.storage.sql
        .exec(`SELECT name FROM _directory_copy_tables WHERE reference IS NOT NULL ORDER BY name`).toArray().map((r) => r.name),
      copied: state.storage.sql.exec(`SELECT count(*) AS n FROM sqlite_master WHERE name GLOB '_directory_copy_rows_*'`).one().n,
      tables: state.storage.sql.exec(`SELECT count(*) AS n FROM _directory_copy_tables`).one().n,
    }));
    expect(snapshot.referenced).toEqual(Object.keys(DIRECTORY_COPY_BY_REFERENCE).sort());
    expect(snapshot.copied).toBe(Number(snapshot.tables) - snapshot.referenced.length);
    // Written after the copy's instant: above every horizon, and in snapshot tables the copy already holds.
    await addTenant(dir, 'late');
    await addAccess(dir, 'late');
  });

  expect(pages.length).toBeGreaterThan(3);
  const merged = mergeDumpPages(pages.map((p) => p.tables));
  expect(merged).toEqual(whole);

  // The restore path the backup's copy takes: the merged pages into a fresh directory.
  const restored = open().dir;
  await restored.importDump(merged);
  expect((await restored.listTenants()).map((t) => t.id).sort()).toEqual(['t-0', 't-1', 't-2', 't-3', 't-4', 't-5']);
  const rows = (tables: ScopeDumpTable[], name: string) => tables.find((t) => t.name === name)!.rows.length;
  const back = await restored.exportDump();
  expect([rows(back, '_substrat_admin_log'), rows(back, '_substrat_access_log')]).toEqual([6, 6]);
  // And it takes writes: a restored directory is a working one, not a read-only image.
  await addTenant(restored, 'after-restore');
  expect(await restored.listTenants()).toHaveLength(7);
});

it('refuses a copy whose append-only table lost a row under its horizon while it was read', async () => {
  const { dir, stub } = await seeded();
  // One row a page, so the admin log is still unread when the row goes.
  await expect(() =>
    copy(
      dir,
      'on',
      () => runInDurableObject(stub, (_i, state) => void state.storage.sql.exec(`DELETE FROM _substrat_admin_log WHERE id = 'adm-3'`)),
      1,
    ),
  ).rejects.toThrow(/_substrat_admin_log lost 1 row\(s\) while this copy was read/);
});

it('verify: copies as before, and reports what a by-reference copy would have held instead', async () => {
  const { dir } = await seeded();
  const whole = await dir.exportDump();
  const pages = await copy(dir, 'verify', async () => {
    // A drain stamps two rows and the prune removes the oldest: both are in R2 by then.
    await dir.markAccessLogDrained('acc-1', AT);
    await dir.pruneAccessLog(1);
    await addTenant(dir, 'late');
  });

  expect(mergeDumpPages(pages.map((p) => p.tables))).toEqual(whole);
  const checks = pages.at(-1)!.referenceCheck!;
  expect(checks.find((c) => c.table === '_substrat_access_log')).toEqual({
    table: '_substrat_access_log', kind: 'log', snapshotRows: 6, missing: 1, changed: 1,
    changedColumns: { drained_at: 1 }, extra: 0, ddlChanged: false,
  });
  expect(checks.find((c) => c.table === '_substrat_admin_log')).toEqual({
    table: '_substrat_admin_log', kind: 'append-only', snapshotRows: 6, missing: 0, changed: 0,
    changedColumns: {}, extra: 0, ddlChanged: false,
  });
  expect(pages.slice(0, -1).every((p) => p.referenceCheck === undefined)).toBe(true);
});

/**
 * The append-only claim, held in source: a by-reference read cannot see a row rewritten under its
 * horizon, so no writer may UPDATE, REPLACE or upsert one. A removed row is caught at run time
 * (above). A statement whose table name is built at run time is out of this scan's sight.
 */
it('no source rewrites a row of an append-only by-reference table', () => {
  const sources = {
    ...import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true }),
    ...import.meta.glob('../../kernel/src/**/*.ts', { query: '?raw', import: 'default', eager: true }),
  };
  expect(Object.keys(sources).length).toBeGreaterThan(50);
  const appendOnly = Object.entries(DIRECTORY_COPY_BY_REFERENCE).filter(([, t]) => t.kind === 'append-only').map(([n]) => n);
  const offences: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    if (file.includes('.test.')) continue;
    for (const table of appendOnly) {
      const rewrite = new RegExp(
        `(UPDATE\\s+(OR\\s+\\w+\\s+)?"?${table}\\b|REPLACE\\s+INTO\\s+"?${table}\\b|INTO\\s+"?${table}\\b[^;\`]*?DO\\s+UPDATE)`,
        'i',
      );
      if (rewrite.test(text)) offences.push(`${file}: ${table}`);
    }
  }
  expect(offences).toEqual([]);
});
