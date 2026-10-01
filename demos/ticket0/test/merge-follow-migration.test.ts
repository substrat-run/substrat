import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ticket0Migrations } from '../src/migrations.generated.js';

describe('historical merge follow repair (#1858)', () => {
  it('withdraws losing follows and stale moved-row edges, preserving survivor access', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE _substrat_tuples (
          subject TEXT NOT NULL, relation TEXT NOT NULL, object TEXT NOT NULL, revoked_at TEXT
        );
        CREATE TABLE ticket0_conversations (id TEXT PRIMARY KEY, merged_into TEXT);
        CREATE TABLE ticket0_messages (id TEXT PRIMARY KEY, conversation_id TEXT);
        CREATE TABLE ticket0_ai_turns (id TEXT PRIMARY KEY, conversation_id TEXT);
        CREATE TABLE ticket0_widget_sessions (id TEXT PRIMARY KEY, conversation_id TEXT);
        CREATE TABLE ticket0_conversation_follows (principal TEXT, conversation_id TEXT);
        INSERT INTO ticket0_conversations VALUES ('loser', 'survivor'), ('survivor', NULL);
        INSERT INTO ticket0_messages VALUES ('moved-message', 'survivor');
        INSERT INTO ticket0_ai_turns VALUES ('moved-turn', 'survivor');
        INSERT INTO ticket0_widget_sessions VALUES ('moved-session', 'survivor');
        INSERT INTO ticket0_conversation_follows VALUES ('losing-follower', 'loser');
        INSERT INTO ticket0_conversation_follows VALUES ('surviving-follower', 'survivor');
      `);
      const tuple = db.prepare('INSERT INTO _substrat_tuples VALUES (?, ?, ?, NULL)');
      for (const child of ['message:moved-message', 'aiTurn:moved-turn', 'widgetSession:moved-session']) {
        tuple.run(child, 'parent', 'conversation:loser');
        tuple.run(child, 'parent', 'conversation:survivor');
      }
      tuple.run('principal:losing-follower', 'granted:conversation:read', 'conversation:loser');
      tuple.run('principal:surviving-follower', 'granted:conversation:read', 'conversation:survivor');
      tuple.run('role:desk-agent', 'granted:conversation:read', 'scope:desk');

      db.exec(ticket0Migrations.find((m) => m.version === '0020')!.sql);

      const live = db.prepare('SELECT subject, relation, object FROM _substrat_tuples WHERE revoked_at IS NULL ORDER BY subject, object').all();
      expect(live).toEqual([
        { subject: 'aiTurn:moved-turn', relation: 'parent', object: 'conversation:survivor' },
        { subject: 'message:moved-message', relation: 'parent', object: 'conversation:survivor' },
        { subject: 'principal:surviving-follower', relation: 'granted:conversation:read', object: 'conversation:survivor' },
        { subject: 'role:desk-agent', relation: 'granted:conversation:read', object: 'scope:desk' },
        { subject: 'widgetSession:moved-session', relation: 'parent', object: 'conversation:survivor' },
      ]);
      expect(db.prepare('SELECT * FROM ticket0_conversation_follows').all()).toEqual([
        { principal: 'surviving-follower', conversation_id: 'survivor' },
      ]);
    } finally {
      db.close();
    }
  });
});
