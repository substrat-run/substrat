import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ticket0Migrations } from '../src/migrations.generated.js';

/**
 * Migration 0026 (#2044), on the shape 0024 left: every public message under every session
 * on its conversation. Afterwards each public message hangs once under its conversation's
 * thread, the thread under its conversation and under each session currently on it, and
 * 0024's per-session message edges are tombstoned.
 */
describe('public threads, for desks that predate them (#2044)', () => {
  it('moves the per-session message edges onto one thread per conversation, idempotently', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE _substrat_tuples (
          subject TEXT NOT NULL, relation TEXT NOT NULL, object TEXT NOT NULL,
          expires_at TEXT, revoked_at TEXT, PRIMARY KEY (subject, relation, object)
        );
        CREATE TABLE ticket0_conversations (id TEXT PRIMARY KEY);
        CREATE TABLE ticket0_messages (id TEXT PRIMARY KEY, conversation_id TEXT, visibility TEXT);
        CREATE TABLE ticket0_widget_sessions (id TEXT PRIMARY KEY, conversation_id TEXT);
        INSERT INTO ticket0_conversations VALUES ('merged'), ('closed'), ('mail');
        -- Two sessions on one conversation (a merge), none on a closed one or on mail.
        INSERT INTO ticket0_widget_sessions VALUES ('s1', 'merged'), ('s2', 'merged');
        INSERT INTO ticket0_messages VALUES
          ('m-public', 'merged', 'public'),
          ('m-note', 'merged', 'internal'),
          ('m-forward', 'merged', 'forward'),
          ('c-public', 'closed', 'public'),
          ('mail-public', 'mail', 'public');
      `);
      // What 0024 and the code after it left: conversation edges, session edges, and each
      // public message under each session on its conversation — one of them already moved.
      const tuple = db.prepare(`INSERT INTO _substrat_tuples (subject, relation, object, revoked_at) VALUES (?, 'parent', ?, ?)`);
      for (const [s, o, r] of [
        ['widgetSession:s1', 'conversation:merged', null],
        ['widgetSession:s2', 'conversation:merged', null],
        ['message:m-public', 'conversation:merged', null],
        ['message:m-note', 'conversation:merged', null],
        ['message:m-forward', 'conversation:merged', null],
        ['message:c-public', 'conversation:closed', null],
        ['message:mail-public', 'conversation:mail', null],
        ['message:m-public', 'widgetSession:s1', null],
        ['message:m-public', 'widgetSession:s2', null],
        ['message:c-public', 'widgetSession:s1', '2026-01-01T00:00:00.000Z'],
      ] as const) {
        tuple.run(s, o, r);
      }

      db.exec(ticket0Migrations.find((m) => m.version === '0025')!.sql);
      const sql = ticket0Migrations.find((m) => m.version === '0026')!.sql;
      const all = () => db.prepare(`SELECT * FROM _substrat_tuples ORDER BY subject, object`).all();
      const threads = () => db.prepare(`SELECT id FROM ticket0_public_threads ORDER BY id`).all();
      db.exec(sql);
      const once = { tuples: all(), threads: threads() };
      // Idempotent: a second run inserts nothing and tombstones nothing more.
      db.exec(sql);
      expect({ tuples: all(), threads: threads() }).toEqual(once);

      expect(threads()).toEqual([{ id: 'closed' }, { id: 'mail' }, { id: 'merged' }]);
      const live = db
        .prepare(`SELECT subject, object FROM _substrat_tuples WHERE revoked_at IS NULL ORDER BY subject, object`)
        .all();
      expect(live).toEqual([
        { subject: 'message:c-public', object: 'conversation:closed' },
        { subject: 'message:c-public', object: 'publicThread:closed' },
        { subject: 'message:m-forward', object: 'conversation:merged' },
        { subject: 'message:m-note', object: 'conversation:merged' },
        { subject: 'message:m-public', object: 'conversation:merged' },
        { subject: 'message:m-public', object: 'publicThread:merged' },
        { subject: 'message:mail-public', object: 'conversation:mail' },
        { subject: 'message:mail-public', object: 'publicThread:mail' },
        { subject: 'publicThread:closed', object: 'conversation:closed' },
        { subject: 'publicThread:mail', object: 'conversation:mail' },
        { subject: 'publicThread:merged', object: 'conversation:merged' },
        { subject: 'publicThread:merged', object: 'widgetSession:s1' },
        { subject: 'publicThread:merged', object: 'widgetSession:s2' },
        { subject: 'widgetSession:s1', object: 'conversation:merged' },
        { subject: 'widgetSession:s2', object: 'conversation:merged' },
      ]);
      // 0024's edges are tombstoned, as a relink would leave them — not deleted. The one
      // already tombstoned keeps its original stamp.
      const tombstones = db
        .prepare(`SELECT subject, object, revoked_at FROM _substrat_tuples WHERE object LIKE 'widgetSession:%' AND subject LIKE 'message:%' ORDER BY subject, object`)
        .all() as { subject: string; object: string; revoked_at: string | null }[];
      expect(tombstones.map((t) => [t.subject, t.object, t.revoked_at !== null])).toEqual([
        ['message:c-public', 'widgetSession:s1', true],
        ['message:m-public', 'widgetSession:s1', true],
        ['message:m-public', 'widgetSession:s2', true],
      ]);
      expect(tombstones[0]!.revoked_at).toBe('2026-01-01T00:00:00.000Z');
    } finally {
      db.close();
    }
  });
});
