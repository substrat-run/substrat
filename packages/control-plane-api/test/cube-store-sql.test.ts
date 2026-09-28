import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CUBE_PART_CHARS, CUBE_RETENTION_MS, splitRows, sqlCubeStore, type SqlExecLike } from '../src/cube-store-sql.js';

/**
 * The SQLite store behind the cube cache (#1877), on real SQLite. The Durable Object's
 * `sql.exec` is the same shape — one statement, positional params, rows back — so this is
 * the code production runs, over the other engine.
 */
function sqlOver(db: Database.Database): SqlExecLike {
  return {
    exec(sql, ...params) {
      const stmt = db.prepare(sql);
      if (stmt.reader) return { toArray: () => stmt.all(...params) as Array<Record<string, unknown>> };
      stmt.run(...params);
      return { toArray: () => [] };
    },
  };
}

const NOW = Date.parse('2026-09-28T12:00:00Z');

describe('the SQL cube store (#1877)', () => {
  it('keeps a block and gives it back whole', async () => {
    const store = sqlCubeStore(sqlOver(new Database(':memory:')), { now: () => NOW });
    const rows = [{ bucket: 1, tenantId: 'T', count: 3 }, { bucket: 2, tenantId: 'U', count: 4 }];
    await store.put('k1', { rows, estimated: true }, NOW);
    const got = await store.get(['k1', 'missing']);
    expect(got.get('k1')).toEqual({ rows, estimated: true });
    expect(got.has('missing')).toBe(false);
  });

  it('splits a block bigger than a Durable Object row can hold, and stitches it back', async () => {
    const db = new Database(':memory:');
    const store = sqlCubeStore(sqlOver(db), { now: () => NOW });
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ bucket: i, tenantId: 'T'.repeat(40), operation: `acme/op-${i}`, count: i }));
    await store.put('big', { rows, estimated: false }, NOW);
    const parts = db.prepare("SELECT COUNT(*) AS n, MAX(LENGTH(rows)) AS longest FROM cube_blocks WHERE key = 'big'").get() as { n: number; longest: number };
    expect(parts.n).toBeGreaterThan(1);
    expect(parts.longest).toBeLessThanOrEqual(CUBE_PART_CHARS);
    expect((await store.get(['big'])).get('big')!.rows).toEqual(rows);
  });

  it('reads a torn write as missing, never as a smaller answer', async () => {
    const db = new Database(':memory:');
    const store = sqlCubeStore(sqlOver(db), { now: () => NOW });
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ bucket: i, tenantId: 'T'.repeat(40), count: i }));
    await store.put('torn', { rows, estimated: false }, NOW);
    // The write stopped after its first part.
    db.prepare("DELETE FROM cube_blocks WHERE key = 'torn' AND part > 0").run();
    expect((await store.get(['torn'])).has('torn')).toBe(false);
  });

  it('replaces a block written twice, and prunes blocks older than the logs they came from', async () => {
    const db = new Database(':memory:');
    const store = sqlCubeStore(sqlOver(db), { now: () => NOW });
    await store.put('old', { rows: [{ n: 1 }], estimated: false }, NOW - CUBE_RETENTION_MS - 1);
    await store.put('k', { rows: [{ n: 1 }], estimated: false }, NOW);
    await store.put('k', { rows: [{ n: 2 }], estimated: false }, NOW);
    const got = await store.get(['old', 'k']);
    expect(got.has('old')).toBe(false);
    expect(got.get('k')!.rows).toEqual([{ n: 2 }]);
  });

  it('splits an empty block into one empty part', () => {
    expect(splitRows([])).toEqual(['[]']);
  });
});
