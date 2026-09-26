import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { exportReadQuery } from '@substrat-run/kernel';

/**
 * #1787, the node half: the export read's plan holds with and without table statistics. The
 * workerd half, on a real Durable Object's spine (`adapter-cloudflare/test/do-sql-limits.test.ts`),
 * is the one that matters. This one keeps the node adapter honest, since self-host and CI run it.
 * The table is the outbox's key and the two indexes the read can choose between, not the whole spine.
 */
describe('exportReadQuery keeps the (type, id) index once statistics exist (#1787)', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE _substrat_outbox (id TEXT PRIMARY KEY, type TEXT NOT NULL, occurred_at TEXT NOT NULL, payload TEXT);
    CREATE INDEX _substrat_outbox_type_at ON _substrat_outbox (type, occurred_at);
    CREATE INDEX _substrat_outbox_type_id ON _substrat_outbox (type, id);
  `);
  const insert = db.prepare('INSERT INTO _substrat_outbox (id, type, occurred_at) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (let i = 0; i < 20_000; i++) insert.run(`01J${String(i).padStart(23, '0')}`, `probe.t${i % 50}`, '2026-09-25T00:00:00.000Z');
  })();

  const wanted = ['probe.t1', 'probe.t2', 'probe.t3'];
  const cursor = `01J${String(5_000).padStart(23, '0')}`;
  const plan = (q: { sql: string; params: unknown[] }): string =>
    (db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params) as { detail: string }[]).map((r) => r.detail).join(' | ');
  const ids = (q: { sql: string; params: unknown[] }): string[] =>
    (db.prepare(q.sql).all(...q.params) as { id: string }[]).map((r) => r.id);
  const listed = `SELECT * FROM _substrat_outbox WHERE type IN (?, ?, ?) AND id > ? ORDER BY id LIMIT ?`;

  for (const phase of ['without statistics', 'after ANALYZE']) {
    it(`seeks (type, id) and reads what the listed form read (${phase})`, () => {
      if (phase === 'after ANALYZE') {
        db.exec('ANALYZE');
        expect(db.prepare('SELECT COUNT(*) AS c FROM sqlite_stat1').get()).toMatchObject({ c: expect.any(Number) });
      }
      const q = exportReadQuery([...wanted, 'probe.t1'], cursor, 1000);
      expect(plan(q)).toContain('_substrat_outbox_type_id (type=? AND id>?)');
      expect(plan(q)).not.toContain('sqlite_autoindex__substrat_outbox');
      expect(ids(q)).toEqual((db.prepare(listed).all(...wanted, cursor, 1000) as { id: string }[]).map((r) => r.id));
      expect(ids(q)).toHaveLength(3 * (20_000 / 50 - 100));
    });
  }
});
