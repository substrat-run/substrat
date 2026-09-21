import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { effectiveRoleGrantQuery, SEAT_SCOPE_TUPLE_SQL } from '../src/index.js';

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

/**
 * #1659 review: the lockout predicate counts only a grant the checker would EXPAND. A live
 * `role:<key>` tuple whose role the vertical no longer defines authorizes nobody (the local
 * checker's `getRole` answers `undefined` for it), so it must not count as "someone holds a
 * role" — or the owner re-seat, and the #332 flip guard, treat a locked-out scope as served.
 * The tables are the scope DO's shapes: scope tuples, projected tenant tuples, role defs.
 */
describe('effectiveRoleGrantQuery (#1659)', () => {
  const T = 'tenant-a';
  const NOW = '2026-09-21T00:00:00.000Z';
  const fresh = (): DatabaseSync => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE _substrat_tuples (
      subject TEXT NOT NULL, relation TEXT NOT NULL, object TEXT NOT NULL,
      expires_at TEXT, revoked_at TEXT, PRIMARY KEY (subject, relation, object)
    )`);
    db.exec(`CREATE TABLE _substrat_tenant_tuples (
      tenant_id TEXT NOT NULL, subject TEXT NOT NULL, relation TEXT NOT NULL, object TEXT NOT NULL,
      expires_at TEXT, revoked_at TEXT, PRIMARY KEY (tenant_id, subject, relation, object)
    )`);
    db.exec(`CREATE TABLE _substrat_roles (
      tenant_id TEXT NOT NULL, role_key TEXT NOT NULL, permissions TEXT NOT NULL, source TEXT NOT NULL,
      revoked_at TEXT, PRIMARY KEY (tenant_id, role_key)
    )`);
    return db;
  };
  const role = (db: DatabaseSync, key: string, tenant = T, revokedAt: string | null = null): void => {
    db.prepare(`INSERT INTO _substrat_roles VALUES (?, ?, '["x:read"]', 'vertical', ?)`).run(tenant, key, revokedAt);
  };
  const scopeTuple = (
    db: DatabaseSync,
    key: string,
    over: { expiresAt?: string | null; revokedAt?: string | null } = {},
  ): void => {
    db.prepare(`INSERT INTO _substrat_tuples VALUES ('principal:p1', ?, 'scope:s1', ?, ?)`).run(
      `role:${key}`,
      over.expiresAt ?? null,
      over.revokedAt ?? null,
    );
  };
  const tenantTuple = (db: DatabaseSync, key: string, tenant = T): void => {
    db.prepare(`INSERT INTO _substrat_tenant_tuples VALUES (?, 'principal:p2', ?, ?, NULL, NULL)`).run(
      tenant,
      `role:${key}`,
      `tenant:${tenant}`,
    );
  };
  const effective = (db: DatabaseSync): boolean => {
    const q = effectiveRoleGrantQuery(T, NOW);
    return (db.prepare(q.sql).get(...q.params) as { effective: number }).effective === 1;
  };

  it('a live tuple for a CURRENT role is effective', () => {
    const db = fresh();
    role(db, 'office-admin');
    scopeTuple(db, 'office-admin');
    expect(effective(db)).toBe(true);
  });

  it('a live tuple for a role the vertical NO LONGER defines is not — the stale grant', () => {
    const db = fresh();
    role(db, 'office-admin'); // defined, but nobody holds it
    scopeTuple(db, 'retired'); // held, but no longer defined
    expect(effective(db)).toBe(false);
  });

  it('a tuple for a REVOKED role definition is not', () => {
    const db = fresh();
    role(db, 'office-admin', T, '2026-09-01T00:00:00.000Z');
    scopeTuple(db, 'office-admin');
    expect(effective(db)).toBe(false);
  });

  it('a revoked or expired tuple is not, even for a current role', () => {
    const revoked = fresh();
    role(revoked, 'office-admin');
    scopeTuple(revoked, 'office-admin', { revokedAt: '2026-09-01T00:00:00.000Z' });
    expect(effective(revoked)).toBe(false);

    const expired = fresh();
    role(expired, 'office-admin');
    scopeTuple(expired, 'office-admin', { expiresAt: '2026-09-20T00:00:00.000Z' });
    expect(effective(expired)).toBe(false);

    const unexpired = fresh();
    role(unexpired, 'office-admin');
    scopeTuple(unexpired, 'office-admin', { expiresAt: '2026-09-22T00:00:00.000Z' });
    expect(effective(unexpired)).toBe(true);
  });

  it("a role defined only for ANOTHER tenant does not make this tenant's tuple effective", () => {
    const db = fresh();
    role(db, 'office-admin', 'tenant-b');
    scopeTuple(db, 'office-admin');
    expect(effective(db)).toBe(false);
  });

  it("a projected TENANT-level tuple counts, for this tenant's current role only", () => {
    const db = fresh();
    role(db, 'member');
    tenantTuple(db, 'member', 'tenant-b'); // another tenant's projection — not ours
    expect(effective(db)).toBe(false);
    tenantTuple(db, 'member'); // ours
    expect(effective(db)).toBe(true);
  });
});
