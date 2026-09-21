import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SEAT_SCOPE_TUPLE_SQL } from '../src/index.js';

/**
 * #1659: the provisioning seat, executed against a real SQLite rather than read as a
 * string. The table is the scope-tuple shape both adapters declare: the primary key the
 * statement's `ON CONFLICT` names, and the K-21 `revoked_at` tombstone. Each adapter also
 * runs the statement against its own DDL (`provision-seat.test.ts` on the pure adapter, the
 * `#1659` blocks in the Cloudflare contract file on workerd).
 */
describe('SEAT_SCOPE_TUPLE_SQL (#1659)', () => {
  const fresh = (): DatabaseSync => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE _substrat_tuples (
      subject TEXT NOT NULL,
      relation TEXT NOT NULL,
      object TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      PRIMARY KEY (subject, relation, object)
    )`);
    return db;
  };
  const seat = (db: DatabaseSync, expiresAt: string | null): void => {
    db.prepare(SEAT_SCOPE_TUPLE_SQL).run('system:@m/x', 'granted:x:run', 'scope:s1', expiresAt);
  };
  const rows = (db: DatabaseSync): unknown[] =>
    db.prepare('SELECT subject, relation, object, expires_at, revoked_at FROM _substrat_tuples').all();

  it('creates a missing tuple, live', () => {
    const db = fresh();
    seat(db, null);
    expect(rows(db)).toEqual([
      { subject: 'system:@m/x', relation: 'granted:x:run', object: 'scope:s1', expires_at: null, revoked_at: null },
    ]);
  });

  it("follows the platform's expiry on a LIVE tuple", () => {
    const db = fresh();
    seat(db, '2099-01-01T00:00:00.000Z');
    seat(db, '2099-06-01T00:00:00.000Z');
    expect(rows(db)).toEqual([
      expect.objectContaining({ expires_at: '2099-06-01T00:00:00.000Z', revoked_at: null }),
    ]);
  });

  it('leaves a TOMBSTONED tuple exactly as it is — revoke and expiry both', () => {
    const db = fresh();
    db.prepare(
      `INSERT INTO _substrat_tuples (subject, relation, object, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('system:@m/x', 'granted:x:run', 'scope:s1', '2099-01-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    seat(db, null);
    seat(db, '2099-06-01T00:00:00.000Z');
    expect(rows(db)).toEqual([
      {
        subject: 'system:@m/x',
        relation: 'granted:x:run',
        object: 'scope:s1',
        expires_at: '2099-01-01T00:00:00.000Z',
        revoked_at: '2026-09-01T00:00:00.000Z',
      },
    ]);
  });

  it('touches only its own (subject, relation, object) row', () => {
    const db = fresh();
    db.prepare(
      `INSERT INTO _substrat_tuples (subject, relation, object, expires_at, revoked_at) VALUES (?, ?, ?, NULL, ?)`,
    ).run('system:@m/x', 'granted:x:run', 'scope:s2', '2026-09-01T00:00:00.000Z');
    seat(db, null); // scope:s1 — a different object, so a new row beside the tombstone
    expect(rows(db)).toHaveLength(2);
    expect(
      db.prepare(`SELECT revoked_at FROM _substrat_tuples WHERE object = 'scope:s2'`).get(),
    ).toEqual({ revoked_at: '2026-09-01T00:00:00.000Z' });
  });
});
