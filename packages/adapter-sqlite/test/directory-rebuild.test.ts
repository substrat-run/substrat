import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #1573: the two directory tables the host rebuilds in place — `_substrat_identities`
 * (K-22, rekeyed) and `_substrat_admin_log` (K-23, `tenant_id` made nullable) — are
 * create-copy-drop-rename, and the rebuild is ONE transaction.
 *
 * Why that matters is the state between DROP and RENAME. Left in autocommit, a stop there
 * leaves the copied rows in `<table>_new` and no `<table>` at all; the next open runs the
 * bootstrap first, its `CREATE TABLE IF NOT EXISTS` puts an EMPTY table of the new shape
 * back, and detection — which reads the stored DDL — concludes the migration is done.
 * The rows stay orphaned for good and nothing errors.
 *
 * The interruption here is a REAL one, not a stubbed `exec`: a stub that throws before
 * running anything leaves nothing half-done, so it would pass with the transaction
 * removed. SQLite refuses `ALTER TABLE … RENAME` while any view names a table that is no
 * longer there ("error in view …: no such table") — and a rebuild has just dropped it. So
 * a view over the table lets DROP land and makes RENAME fail, on the actual engine, at the
 * actual statement. Whether DROP's effect is still there afterwards is exactly the
 * property under test.
 */
interface Case {
  table: string;
  /** The pre-migration DDL the directory was created with. */
  legacyDdl: string;
  /** The stored-DDL fragment that says "still the old shape". */
  legacyMarker: string;
  insert: string;
  rows: unknown[][];
  /** Reads the rows back in a stable order, in columns both shapes share. */
  select: string;
  expected: Record<string, unknown>[];
}

const CASES: Case[] = [
  {
    table: '_substrat_identities',
    legacyDdl: `CREATE TABLE _substrat_identities (
      provider     TEXT NOT NULL,
      external_id  TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      tenant_id    TEXT NOT NULL,
      scope_id     TEXT,
      created_at   TEXT NOT NULL,
      PRIMARY KEY (provider, external_id)
    )`,
    legacyMarker: 'PRIMARY KEY (provider, external_id)',
    insert:
      'INSERT INTO _substrat_identities (provider, external_id, principal_id, tenant_id, scope_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    rows: [
      ['oidc:acme', 'user-1', 'principal-1', 'tenant-a', null, '2026-09-01T00:00:00.000Z'],
      ['oidc:acme', 'user-2', 'principal-2', 'tenant-a', 'scope-1', '2026-09-02T00:00:00.000Z'],
    ],
    select: 'SELECT provider, external_id, principal_id, tenant_id, scope_id, created_at FROM _substrat_identities ORDER BY external_id',
    expected: [
      {
        provider: 'oidc:acme',
        external_id: 'user-1',
        principal_id: 'principal-1',
        tenant_id: 'tenant-a',
        scope_id: null,
        created_at: '2026-09-01T00:00:00.000Z',
      },
      {
        provider: 'oidc:acme',
        external_id: 'user-2',
        principal_id: 'principal-2',
        tenant_id: 'tenant-a',
        scope_id: 'scope-1',
        created_at: '2026-09-02T00:00:00.000Z',
      },
    ],
  },
  {
    table: '_substrat_admin_log',
    legacyDdl: `CREATE TABLE _substrat_admin_log (
      id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      scope_id TEXT,
      vertical TEXT,
      before TEXT,
      after TEXT,
      at TEXT NOT NULL
    )`,
    legacyMarker: 'tenant_id TEXT NOT NULL',
    insert:
      'INSERT INTO _substrat_admin_log (id, actor, action, tenant_id, scope_id, vertical, before, after, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    rows: [
      ['log-1', 'staff-1', 'tenant.created', 'tenant-a', null, null, null, '{"slug":"a"}', '2026-09-01T00:00:00.000Z'],
      ['log-2', 'staff-1', 'scope.activated', 'tenant-a', 'scope-1', 'v', '{"s":"p"}', '{"s":"a"}', '2026-09-02T00:00:00.000Z'],
    ],
    select: 'SELECT id, actor, action, tenant_id, scope_id, vertical, before, after, at FROM _substrat_admin_log ORDER BY id',
    expected: [
      {
        id: 'log-1',
        actor: 'staff-1',
        action: 'tenant.created',
        tenant_id: 'tenant-a',
        scope_id: null,
        vertical: null,
        before: null,
        after: '{"slug":"a"}',
        at: '2026-09-01T00:00:00.000Z',
      },
      {
        id: 'log-2',
        actor: 'staff-1',
        action: 'scope.activated',
        tenant_id: 'tenant-a',
        scope_id: 'scope-1',
        vertical: 'v',
        before: '{"s":"p"}',
        after: '{"s":"a"}',
        at: '2026-09-02T00:00:00.000Z',
      },
    ],
  },
];

describe.each(CASES)('#1573: the $table rebuild is atomic', (c) => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-directory-rebuild-'));
    file = join(dir, '_directory.sqlite');
    // A directory in the OLD shape, with rows in it — hand-built, since only here can a
    // test reach into the store and put the old table back.
    const db = new Database(file);
    db.exec(c.legacyDdl);
    const insert = db.prepare(c.insert);
    for (const row of c.rows) insert.run(...row);
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Reads the directory file on its own connection, closing it before it returns. */
  const inspect = <T>(read: (db: Database.Database) => T): T => {
    const db = new Database(file, { readonly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  };
  const storedSql = () =>
    inspect(
      (db) =>
        (
          db
            .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(c.table) as { sql: string } | undefined
        )?.sql,
    );
  const scratchTables = () =>
    inspect((db) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%\\_new' ESCAPE '\\'").all(),
    );

  it('migrates every row, and is a no-op on the open after', async () => {
    // The positive twin. Without it a change that simply refused to rebuild would pass
    // the interruption test below by leaving the table alone.
    for (let open = 1; open <= 2; open += 1) {
      await new SqliteScopeHost({ dir }).close();
      expect(inspect((db) => db.prepare(c.select).all())).toEqual(c.expected);
      expect(storedSql()).not.toContain(c.legacyMarker);
      expect(scratchTables()).toEqual([]);
    }
  });

  it('an interruption between DROP and RENAME leaves the table and its rows exactly as they were', () => {
    // The fault: a view over the table, so RENAME dies AFTER DROP has run.
    const setup = new Database(file);
    setup.exec(`CREATE VIEW rebuild_probe AS SELECT * FROM ${c.table}`);
    setup.close();

    expect(() => new SqliteScopeHost({ dir })).toThrow(/error in view rebuild_probe/);

    // Rolled back, not merely "a table exists": the OLD shape, every row, and no scratch
    // table holding a copy. In autocommit this is the state where `${c.table}` is gone
    // and its rows sit in `${c.table}_new`.
    expect(storedSql() ?? `${c.table} is gone`).toContain(c.legacyMarker);
    expect(inspect((db) => db.prepare(c.select).all())).toEqual(c.expected);
    expect(scratchTables()).toEqual([]);
  });

  it('and the next open, once the interruption is cleared, still migrates every row', async () => {
    // What the silent failure is: not the crash, but the open AFTER it, which in
    // autocommit finds an empty new-shape table and reports the migration done.
    const setup = new Database(file);
    setup.exec(`CREATE VIEW rebuild_probe AS SELECT * FROM ${c.table}`);
    setup.close();
    expect(() => new SqliteScopeHost({ dir })).toThrow(/error in view/);

    const clear = new Database(file);
    clear.exec('DROP VIEW rebuild_probe');
    clear.close();

    await new SqliteScopeHost({ dir }).close();
    expect(inspect((db) => db.prepare(c.select).all())).toEqual(c.expected);
    expect(storedSql()).not.toContain(c.legacyMarker);
    expect(scratchTables()).toEqual([]);
  });

  it('absorbs a leftover scratch table rather than dying on it, and does not resume from it', async () => {
    // The state that can still arrive from BELOW the transaction (a torn copy of the
    // file, a backup taken mid-rebuild). Without the leading DROP the rebuild dies on
    // `table …_new already exists`, on every open, for good.
    const stale = new Database(file);
    stale.exec(`CREATE TABLE ${c.table}_new (marker TEXT)`);
    stale.exec(`INSERT INTO ${c.table}_new VALUES ('stale')`);
    stale.close();

    await new SqliteScopeHost({ dir }).close();
    expect(inspect((db) => db.prepare(c.select).all())).toEqual(c.expected);
    expect(scratchTables()).toEqual([]);
  });
});

describe('#1573: the admin log accepts a tenant-less row once rebuilt', () => {
  it('is the point of the rebuild — `tenant_id` no longer NOT NULL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-directory-rebuild-null-'));
    try {
      const db = new Database(join(dir, '_directory.sqlite'));
      db.exec(CASES[1]!.legacyDdl);
      db.close();

      await new SqliteScopeHost({ dir }).close();

      const after = new Database(join(dir, '_directory.sqlite'));
      try {
        after
          .prepare(
            `INSERT INTO _substrat_admin_log (id, actor, action, tenant_id, at) VALUES ('platform-1', 'staff-1', 'platform.thing', NULL, '2026-09-03T00:00:00.000Z')`,
          )
          .run();
        expect(
          after.prepare("SELECT tenant_id FROM _substrat_admin_log WHERE id = 'platform-1'").get(),
        ).toEqual({ tenant_id: null });
      } finally {
        after.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
