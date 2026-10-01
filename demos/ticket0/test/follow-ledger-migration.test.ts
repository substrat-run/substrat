import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ticket0Migrations } from '../src/migrations.generated.js';
import { createKit } from './desk-kit.js';

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

  it('revokes a backfilled follow on an already off-boarded profile during an idempotent retry', async () => {
    const kit = createKit('ticket0-follow-upgrade-');
    try {
      const desk = await kit.freshDesk({ agents: 0 });
      const guest = await kit.guest(desk);
      const admin = await kit.as(desk, desk.admin);
      const conversationId = await kit.mail(desk);
      await admin.invoke('ticket0/set-agent-offboarded', { principal: guest, offboarded: true });

      // Recreate the pre-0019 state: a live tuple but no ledger, then run its backfill.
      kit.sql(desk, (db) => {
        db.exec('DROP TABLE ticket0_conversation_follows');
        db.prepare(`INSERT OR REPLACE INTO _substrat_tuples (subject, relation, object, revoked_at)
          VALUES (?, 'granted:conversation:read', ?, NULL)`)
          .run(`principal:${guest}`, `conversation:${conversationId}`);
        db.exec(ticket0Migrations.find((migration) => migration.version === '0019')!.sql);
      });
      const ledger = () => kit.sql(desk, (db) => db.prepare(
        'SELECT conversation_id FROM ticket0_conversation_follows WHERE principal = ?',
      ).all(guest));
      const canRead = () => kit.as(desk, guest).then((stub) => stub.invoke(
        'ticket0/get-conversation', { conversationId },
      )).then(() => true, () => false);
      expect(ledger()).toEqual([{ conversation_id: conversationId }]);
      expect(await canRead()).toBe(true);

      await admin.invoke('ticket0/set-agent-offboarded', { principal: guest, offboarded: true });
      expect(ledger()).toEqual([]);
      expect(await canRead()).toBe(false);
      expect(kit.events(desk, 'ticket0.conversation-unfollowed', conversationId)
        .map((event) => JSON.parse(event.payload))).toEqual([
        { conversation_id: conversationId, follower: guest },
      ]);
    } finally {
      kit.dispose();
    }
  });
});
