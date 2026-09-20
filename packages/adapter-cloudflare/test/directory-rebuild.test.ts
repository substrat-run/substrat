import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { ulid } from '@substrat-run/kernel';
import { ControlPlaneDO } from '../src/control-plane-do.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #1573, Durable Object half: `ControlPlaneDO` carries its own copies of the two
 * directory rebuilds — `_substrat_identities` (K-22, rekeyed) and `_substrat_admin_log`
 * (K-23, `tenant_id` made nullable) — and they are create-copy-drop-rename inside ONE
 * `transactionSync`.
 *
 * The state to fear is between DROP and RENAME. In autocommit a stop there leaves the
 * copied rows in `<table>_new` and no `<table>`; the next construction runs
 * `DIRECTORY_DDL` first, its `CREATE TABLE IF NOT EXISTS` puts an EMPTY table of the new
 * shape back, detection reads that shape and reports the migration done, and the rows
 * stay orphaned for good with nothing erroring.
 *
 * The interruption is a real one on the real engine, not a stubbed `exec` (a stub that
 * throws before running anything leaves nothing half-done, so it would pass with the
 * transaction removed): SQLite refuses `ALTER TABLE … RENAME` while a view names a table
 * that is no longer there, and a rebuild has just dropped it. A view over the table lets
 * DROP land and makes RENAME fail.
 *
 * The legacy shape is staged by constructing a SECOND `ControlPlaneDO` over the storage
 * the first one already built — which is what a deploy is: new code, old storage.
 */
interface Case {
  table: string;
  legacyDdl: string;
  /** The stored-DDL fragment that says "still the old shape". */
  legacyMarker: string;
  insert: string;
  rows: unknown[][];
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
    select:
      'SELECT provider, external_id, principal_id, tenant_id, scope_id, created_at FROM _substrat_identities ORDER BY external_id',
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
    select:
      'SELECT id, actor, action, tenant_id, scope_id, vertical, before, after, at FROM _substrat_admin_log ORDER BY id',
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

/** What a test reads back from the storage: the table's stored DDL, its rows, any scratch. */
interface Snapshot {
  sql: string | null;
  rows: Record<string, unknown>[];
  scratch: string[];
}

describe.each(CASES)('#1573: ControlPlaneDO rebuilds $table atomically', (c) => {
  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
  });

  /** A fresh directory DO, already built in the NEW shape by its own constructor. */
  const freshDirectory = async () => {
    const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`rebuild-${ulid()}`));
    // Touching it constructs it; the tables now exist in the new shape.
    await runInDurableObject(stub, () => undefined);
    return stub;
  };

  /** Put the OLD table back, with its rows, and any extra setup statements. */
  const stage = (state: DurableObjectState, ...extra: string[]) => {
    state.storage.sql.exec(`DROP TABLE ${c.table}`);
    state.storage.sql.exec(c.legacyDdl);
    for (const row of c.rows) state.storage.sql.exec(c.insert, ...(row as unknown[]));
    for (const stmt of extra) state.storage.sql.exec(stmt);
  };

  const snapshot = (state: DurableObjectState): Snapshot => {
    const sql = state.storage.sql
      .exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", c.table)
      .toArray()[0] as { sql: string } | undefined;
    const tableGone = sql === undefined;
    return {
      sql: tableGone ? null : sql.sql,
      // `select` would throw on a missing table; that IS the failure, so say it as data.
      rows: tableGone ? [] : (state.storage.sql.exec(c.select).toArray() as Record<string, unknown>[]),
      scratch: (
        state.storage.sql
          .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%\\_new' ESCAPE '\\'")
          .toArray() as { name: string }[]
      ).map((r) => r.name),
    };
  };

  /** Construct the class over the storage, as a deploy does. Returns the error, if any. */
  const construct = (state: DurableObjectState): string | null => {
    try {
      new ControlPlaneDO(state, env);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  };

  it('migrates every row, and is a no-op on the construction after', async () => {
    // The positive twin. Without it a change that simply refused to rebuild would pass
    // the interruption test below by leaving the table alone.
    const stub = await freshDirectory();
    const seen = await runInDurableObject(stub, (_instance, state) => {
      stage(state);
      const out: { error: string | null; snap: Snapshot }[] = [];
      for (let construction = 1; construction <= 2; construction += 1) {
        out.push({ error: construct(state), snap: snapshot(state) });
      }
      return out;
    });
    for (const { error, snap } of seen) {
      expect(error).toBeNull();
      expect(snap.rows).toEqual(c.expected);
      expect(snap.sql).not.toContain(c.legacyMarker);
      expect(snap.scratch).toEqual([]);
    }
  });

  it('an interruption between DROP and RENAME leaves the table and its rows exactly as they were', async () => {
    const stub = await freshDirectory();
    const { error, snap } = await runInDurableObject(stub, (_instance, state) => {
      // The fault: a view over the table, so RENAME dies AFTER DROP has run.
      stage(state, `CREATE VIEW rebuild_probe AS SELECT * FROM ${c.table}`);
      return { error: construct(state), snap: snapshot(state) };
    });
    expect(error).toMatch(/error in view rebuild_probe/);
    // Rolled back, not merely "a table exists": the OLD shape, every row, and no scratch
    // table holding a copy. In autocommit this is the state where the table is gone and
    // its rows sit in `<table>_new`.
    expect(snap.sql ?? `${c.table} is gone`).toContain(c.legacyMarker);
    expect(snap.rows).toEqual(c.expected);
    expect(snap.scratch).toEqual([]);
  });

  it('and the next construction, once the interruption is cleared, still migrates every row', async () => {
    // What the silent failure is: not the crash, but the construction AFTER it, which in
    // autocommit finds an empty new-shape table and reports the migration done.
    const stub = await freshDirectory();
    const { first, second, snap } = await runInDurableObject(stub, (_instance, state) => {
      stage(state, `CREATE VIEW rebuild_probe AS SELECT * FROM ${c.table}`);
      const first = construct(state);
      state.storage.sql.exec('DROP VIEW rebuild_probe');
      return { first, second: construct(state), snap: snapshot(state) };
    });
    expect(first).toMatch(/error in view/);
    expect(second).toBeNull();
    expect(snap.rows).toEqual(c.expected);
    expect(snap.sql).not.toContain(c.legacyMarker);
    expect(snap.scratch).toEqual([]);
  });

  it('absorbs a leftover scratch table rather than dying on it, and does not resume from it', async () => {
    // The state that can still arrive from BELOW the transaction (a backup restored
    // mid-rebuild). Without the leading DROP the rebuild dies on `table …_new already
    // exists`, on every construction, for good.
    const stub = await freshDirectory();
    const { error, snap } = await runInDurableObject(stub, (_instance, state) => {
      stage(state, `CREATE TABLE ${c.table}_new (marker TEXT)`, `INSERT INTO ${c.table}_new VALUES ('stale')`);
      return { error: construct(state), snap: snapshot(state) };
    });
    expect(error).toBeNull();
    expect(snap.rows).toEqual(c.expected);
    expect(snap.scratch).toEqual([]);
  });
});
