import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { switchSystemSchedules, systemScheduleState, systemSwitchedOff, type SwitchSql } from '../src/index.js';

/**
 * #1666: the switch's own rule, executed against a real SQLite. Each adapter runs the same
 * functions against its own storage (the shared `systemSwitchContractSuite`, and the
 * `#1666` blocks in both adapters' test files).
 */
describe('switchSystemSchedules (#1666)', () => {
  const M = '@m/x';
  const S = 's1';
  const fresh = (): { db: DatabaseSync; sql: SwitchSql } => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE _substrat_tuples (
      subject TEXT NOT NULL, relation TEXT NOT NULL, object TEXT NOT NULL,
      expires_at TEXT, revoked_at TEXT, PRIMARY KEY (subject, relation, object)
    )`);
    const sql: SwitchSql = {
      all: (q, ...p) => db.prepare(q).all(...p) as Record<string, unknown>[],
      run: (q, ...p) => {
        db.prepare(q).run(...p);
      },
    };
    return { db, sql };
  };
  const grant = (db: DatabaseSync, permission: string, revokedAt: string | null = null) =>
    db
      .prepare(`INSERT OR REPLACE INTO _substrat_tuples VALUES (?, ?, ?, NULL, ?)`)
      .run(`system:${M}`, `granted:${permission}`, `scope:${S}`, revokedAt);
  const revokedAt = (db: DatabaseSync, permission: string) =>
    (
      db
        .prepare(`SELECT revoked_at FROM _substrat_tuples WHERE subject = ? AND relation = ?`)
        .get(`system:${M}`, `granted:${permission}`) as { revoked_at: string | null }
    ).revoked_at;
  const move = (sql: SwitchSql, to: 'on' | 'off', at = '2026-09-21T10:00:00.000Z') =>
    switchSystemSchedules(sql, { moduleId: M, scopeId: S, to, at });

  it('ON gives back exactly what OFF took: a grant revoked independently before OFF stays revoked', () => {
    const { db, sql } = fresh();
    grant(db, 'a:run', '2026-09-01T00:00:00.000Z'); // A: revoked on its own, before the switch
    grant(db, 'b:run'); // B: live when the switch is pulled

    expect(move(sql, 'off')).toEqual({ held: true, changed: true, permissions: ['b:run'] });
    expect(revokedAt(db, 'a:run')).toBe('2026-09-01T00:00:00.000Z'); // untouched by OFF
    expect(revokedAt(db, 'b:run')).toBe('2026-09-21T10:00:00.000Z');

    expect(move(sql, 'on', '2026-09-21T11:00:00.000Z')).toEqual({ held: true, changed: true, permissions: ['b:run'] });
    expect(revokedAt(db, 'a:run')).toBe('2026-09-01T00:00:00.000Z'); // still revoked, same instant
    expect(revokedAt(db, 'b:run')).toBeNull();
    expect(systemScheduleState(sql, M, '2026-09-21T12:00:00.000Z')).toBe('on');
  });

  it('a second OFF/ON cycle gives back only what THAT OFF took', () => {
    const { db, sql } = fresh();
    grant(db, 'a:run');
    grant(db, 'b:run');
    move(sql, 'off');
    move(sql, 'on');
    // Between cycles, A is revoked on its own; the next OFF takes only B.
    grant(db, 'a:run', '2026-09-21T11:30:00.000Z');
    expect(move(sql, 'off').permissions).toEqual(['b:run']);
    expect(move(sql, 'on').permissions).toEqual(['b:run']);
    expect(revokedAt(db, 'a:run')).toBe('2026-09-21T11:30:00.000Z');
  });

  it('systemSwitchedOff reads the marker, and only this module’s', () => {
    const { db, sql } = fresh();
    grant(db, 'a:run');
    expect(systemSwitchedOff(sql, M)).toBe(false);
    move(sql, 'off');
    expect(systemSwitchedOff(sql, M)).toBe(true);
    expect(systemSwitchedOff(sql, '@m/other')).toBe(false);
    move(sql, 'on');
    expect(systemSwitchedOff(sql, M)).toBe(false);
  });
});
