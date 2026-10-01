import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ticket0Migrations } from '../src/migrations.generated.js';

describe('follow ledger migration (#1941)', () => {
  it('backfills existing live entity read grants, including those of already off-boarded staff', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE _substrat_tuples (
        subject TEXT NOT NULL, relation TEXT NOT NULL, object TEXT NOT NULL, revoked_at TEXT
      )`);
      const add = db.prepare('INSERT INTO _substrat_tuples (subject, relation, object, revoked_at) VALUES (?, ?, ?, ?)');
      add.run('principal:agent-a', 'granted:conversation:read', 'conversation:thread-1', null);
      add.run('principal:agent-a', 'granted:conversation:read', 'conversation:thread-2', null);
      add.run('principal:agent-a', 'granted:conversation:read', 'conversation:thread-3', '2026-09-01T00:00:00Z');
      add.run('principal:agent-a', 'granted:contact:read', 'contact:someone', null);
      add.run('system:ticket0', 'granted:conversation:read', 'conversation:thread-4', null);

      db.exec(ticket0Migrations.find((m) => m.version === '0019')!.sql);

      expect(db.prepare('SELECT principal, conversation_id FROM ticket0_conversation_follows ORDER BY conversation_id').all())
        .toEqual([
          { principal: 'agent-a', conversation_id: 'thread-1' },
          { principal: 'agent-a', conversation_id: 'thread-2' },
        ]);
    } finally {
      db.close();
    }
  });
});
