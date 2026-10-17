import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { STORE_KIND_RELEASES_DDL_BEFORE_RENAME } from '@substrat-run/contract-tests';
import { executableSqlStatements, ulid } from '@substrat-run/kernel';
import { ControlPlaneDO } from '../src/control-plane-do.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * K-53's rename, Durable Object half: a directory DO built before it named the release tables
 * `store_kind_*` and keyed them, and `vertical_scope_stores`, by `kind`. Its DDL is all
 * `IF NOT EXISTS`, so new code over that storage would read empty tables beside the old ones.
 * Staged as `sweep-runs-intent-kind.test.ts` stages a deploy: this code builds the directory,
 * the old names are put back with rows in them, and a second `ControlPlaneDO` is constructed
 * over that storage.
 */

const SHA = 'a'.repeat(64);
const DRIVER_TABLES = ['store_driver_current', 'store_driver_holds', 'store_driver_releases', 'store_driver_rollouts'];

const tableNames = (state: DurableObjectState) =>
  (state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray() as { name: string }[]).map((t) => t.name);
const columnsOf = (state: DurableObjectState, table: string) => state.storage.sql.exec(`SELECT * FROM ${table} LIMIT 0`).columnNames;

describe('K-53: a directory DO built before the store driver rename', () => {
  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
  });

  /** A directory DO built by this code, with the names from before the rename put back, holding rows. */
  const legacyDirectory = async () => {
    const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`store-driver-rename-${ulid()}`));
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      for (const table of DRIVER_TABLES) {
        const old = table.replace('store_driver_', 'store_kind_');
        sql.exec(`ALTER TABLE ${table} RENAME TO ${old}`);
        sql.exec(`ALTER TABLE ${old} RENAME COLUMN driver TO kind`);
      }
      // The fleet rebuild's table (#2309) came after the rename: a directory from before it has none.
      sql.exec('DROP TABLE store_driver_rebuilds');
      sql.exec('ALTER TABLE vertical_scope_stores RENAME COLUMN driver TO kind');
      // The walk ledger (#2312) came after the rename, so a directory from before it has none.
      sql.exec('DROP TABLE store_driver_rollout_walks');
      sql.exec(
        'INSERT INTO store_kind_releases (kind, sha256, source_commit, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?)',
        'graph', SHA, 'b'.repeat(40), 'staff', '2026-10-15T00:00:00.000Z',
      );
      sql.exec('INSERT INTO store_kind_current (kind, sha256, seq) VALUES (?, ?, ?)', 'graph', SHA, 1);
      sql.exec(
        'INSERT INTO vertical_scope_stores (vertical_slug, binding, kind, first_version_id) VALUES (?, ?, ?, ?)',
        'docs', 'GRAPH', 'graph', '01JZ0000000000000000000V01',
      );
    });
    return stub;
  };

  it('is staged for real: the old names hold the rows, and the new ones do not exist', async () => {
    const stub = await legacyDirectory();
    const seen = await runInDurableObject(stub, (_instance, state) => ({
      names: tableNames(state),
      bindingColumns: columnsOf(state, 'vertical_scope_stores'),
    }));
    expect(seen.names).toEqual(expect.arrayContaining(['store_kind_releases', 'store_kind_current', 'store_kind_holds', 'store_kind_rollouts']));
    expect(seen.names.filter((n) => n.startsWith('store_driver_'))).toEqual([]);
    expect(seen.bindingColumns).toContain('kind');
  });

  it('moves onto the driver names on construction, keeping every row, and the construction after does nothing', async () => {
    const stub = await legacyDirectory();
    const seen = await runInDurableObject(stub, (_instance, state) => {
      const out = [];
      for (let construction = 1; construction <= 2; construction += 1) {
        const cp = new ControlPlaneDO(state, env);
        out.push({
          release: cp.getStoreDriverRelease('graph', SHA),
          current: cp.storeDriverState('graph').current,
          names: tableNames(state),
          columns: Object.fromEntries([...DRIVER_TABLES, 'vertical_scope_stores'].map((t) => [t, columnsOf(state, t)])),
          bindings: state.storage.sql.exec('SELECT vertical_slug, binding, driver FROM vertical_scope_stores').toArray(),
        });
      }
      return out;
    });
    for (const s of seen) {
      expect(s.release).toMatchObject({ driver: 'graph', sha256: SHA });
      expect(s.current).toMatchObject({ sha256: SHA, seq: 1 });
      expect(s.names.filter((n) => n.startsWith('store_kind_'))).toEqual([]);
      for (const columns of Object.values(s.columns)) {
        expect(columns).toContain('driver');
        expect(columns).not.toContain('kind');
      }
      expect(s.bindings).toEqual([{ vertical_slug: 'docs', binding: 'GRAPH', driver: 'graph' }]);
    }
  });

  // A rollback across the rename and forward again (see the pure host's twin): the code before it
  // creates its tables, empty, beside the moved ones, and `exportDump` dumps every table, so
  // without the cleanup every later directory backup carries both names and restores refused.
  it('after a rollback, drops the empty old tables on construction, keeps rows, and its dump restores', async () => {
    const stub = await legacyDirectory();
    const seen = await runInDurableObject(stub, async (_instance, state) => {
      new ControlPlaneDO(state, env);
      // What the pre-rename code's start does over a moved directory.
      for (const stmt of executableSqlStatements(STORE_KIND_RELEASES_DDL_BEFORE_RENAME)) state.storage.sql.exec(stmt);
      state.storage.sql.exec("INSERT INTO store_kind_holds (kind, holder, mode, expires_at) VALUES ('graph', 'h1', 'shared', 1)");
      const staged = tableNames(state);
      const cp = new ControlPlaneDO(state, env);
      const dump = cp.exportDump();
      await cp.importDump(dump);
      return {
        staged,
        after: tableNames(state),
        dumped: dump.map((t) => t.name),
        release: cp.getStoreDriverRelease('graph', SHA),
        holds: state.storage.sql.exec('SELECT driver, holder FROM store_driver_holds').toArray(),
      };
    });
    expect(seen.staged).toEqual(expect.arrayContaining(['store_kind_releases', 'store_driver_releases']));
    expect(seen.dumped.filter((n) => n.startsWith('store_kind_'))).toEqual([]);
    expect(seen.after.filter((n) => n.startsWith('store_kind_'))).toEqual([]);
    expect(seen.release).toMatchObject({ driver: 'graph', sha256: SHA });
    expect(seen.holds).toEqual([{ driver: 'graph', holder: 'h1' }]);
  });
});
