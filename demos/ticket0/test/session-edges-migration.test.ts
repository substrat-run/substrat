import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ticket0Migrations } from '../src/migrations.generated.js';

describe('widget session edges, for desks that predate them (#1853)', () => {
  it('leaves each session one parent, and hangs its conversation’s public messages under it', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE _substrat_tuples (
          subject TEXT NOT NULL, relation TEXT NOT NULL, object TEXT NOT NULL,
          expires_at TEXT, revoked_at TEXT, PRIMARY KEY (subject, relation, object)
        );
        CREATE TABLE ticket0_messages (id TEXT PRIMARY KEY, conversation_id TEXT, visibility TEXT);
        CREATE TABLE ticket0_widget_sessions (id TEXT PRIMARY KEY, conversation_id TEXT);
        -- A session moved onto a follow-up by the old moveSession: linked to both threads.
        INSERT INTO ticket0_widget_sessions VALUES ('moved', 'follow-up'), ('quiet', 'other');
        INSERT INTO ticket0_messages VALUES
          ('old-public', 'closed', 'public'),
          ('new-public', 'follow-up', 'public'),
          ('new-note', 'follow-up', 'internal'),
          ('new-forward', 'follow-up', 'forward'),
          ('elsewhere', 'other', 'public');
      `);
      const tuple = db.prepare(`INSERT INTO _substrat_tuples (subject, relation, object) VALUES (?, 'parent', ?)`);
      tuple.run('widgetSession:moved', 'conversation:closed');
      tuple.run('widgetSession:moved', 'conversation:follow-up');
      tuple.run('widgetSession:quiet', 'conversation:other');

      const sql = ticket0Migrations.find((m) => m.version === '0024')!.sql;
      const all = () => db.prepare(`SELECT * FROM _substrat_tuples ORDER BY subject, object`).all();
      db.exec(sql);
      const once = all();
      // Idempotent: a second run finds no live stale edge and inserts nothing new.
      db.exec(sql);
      expect(all()).toEqual(once);

      const live = db
        .prepare(`SELECT subject, object FROM _substrat_tuples WHERE revoked_at IS NULL ORDER BY subject, object`)
        .all();
      expect(live).toEqual([
        { subject: 'message:elsewhere', object: 'widgetSession:quiet' },
        { subject: 'message:new-public', object: 'widgetSession:moved' },
        { subject: 'widgetSession:moved', object: 'conversation:follow-up' },
        { subject: 'widgetSession:quiet', object: 'conversation:other' },
      ]);
      // The closed thread's edge is tombstoned, as a relink would leave it — not deleted.
      expect(
        db.prepare(`SELECT revoked_at IS NOT NULL AS gone FROM _substrat_tuples WHERE object = 'conversation:closed'`).get(),
      ).toEqual({ gone: 1 });
    } finally {
      db.close();
    }
  });
});
