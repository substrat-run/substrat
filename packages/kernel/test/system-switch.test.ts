import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  switchSystemSchedules,
  systemGrantsStatus,
  systemScheduleState,
  systemSwitchedOff,
  systemSwitchedOffMessage,
  switchRecordedOff,
  peerSwitchedOff,
  recordedOffFromWire,
  tenantHoldsGrant,
  tenantSystemSwitchedOffMessage,
  type SwitchSql,
} from '../src/index.js';

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

    expect(move(sql, 'off')).toEqual({ held: true, changed: true, permissions: ['b:run'], deniesTenantGrants: true });
    expect(revokedAt(db, 'a:run')).toBe('2026-09-01T00:00:00.000Z'); // untouched by OFF
    expect(revokedAt(db, 'b:run')).toBe('2026-09-21T10:00:00.000Z');

    expect(move(sql, 'on', '2026-09-21T11:00:00.000Z')).toEqual({ held: true, changed: true, permissions: ['b:run'], deniesTenantGrants: true });
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

  it('a module held only by the tenant (#1823): OFF writes the marker and tombstones nothing; ON takes it back', () => {
    const { sql } = fresh();
    const tenantMove = (to: 'on' | 'off') =>
      switchSystemSchedules(sql, { moduleId: M, scopeId: S, to, at: '2026-09-21T10:00:00.000Z', tenantHeld: true });
    expect(tenantMove('off')).toEqual({ held: true, changed: true, permissions: [], deniesTenantGrants: true });
    expect(systemSwitchedOff(sql, M)).toBe(true);
    expect(tenantMove('off')).toEqual({ held: true, changed: false, permissions: [], deniesTenantGrants: true });
    expect(tenantMove('on')).toEqual({ held: true, changed: true, permissions: [], deniesTenantGrants: true });
    expect(systemSwitchedOff(sql, M)).toBe(false);
    // Still held while the tenant grant is: a repeat ON is a no-op, not a refusal.
    expect(tenantMove('on')).toEqual({ held: true, changed: false, permissions: [], deniesTenantGrants: true });
  });

  it('twin: without the tenant, the same empty scope holds nothing and writes nothing', () => {
    const { sql } = fresh();
    expect(move(sql, 'off')).toEqual({ held: false, changed: false, permissions: [], deniesTenantGrants: true });
    expect(systemSwitchedOff(sql, M)).toBe(false);
  });

  it('switchRecordedOff holds exactly the modules it is told the tenant holds', () => {
    const { sql } = fresh();
    const out = switchRecordedOff(sql, { scopeId: S, moduleIds: [M, '@m/y'], at: 'x', tenantHeld: [M] });
    expect(out.map((o) => [o.moduleId, o.held])).toEqual([
      [M, true],
      ['@m/y', false],
    ]);
    expect(systemSwitchedOff(sql, M)).toBe(true);
    expect(systemSwitchedOff(sql, '@m/y')).toBe(false);
  });

  it('#2029: switchRecordedOff switches the recorded-off peers too, tenant-held ones included', () => {
    const { db, sql } = fresh();
    db.prepare(`INSERT INTO _substrat_tuples VALUES (?, ?, ?, NULL, NULL)`).run('vertical:acme/a', 'granted:p:read', `scope:${S}`);
    const out = switchRecordedOff(sql, {
      scopeId: S,
      moduleIds: [],
      at: 'x',
      verticals: ['acme/a', 'acme/tenant-only', 'acme/nothing'],
      tenantHeldVerticals: ['acme/tenant-only'],
    });
    expect(out.map((o) => [o.vertical, o.held, o.changed, o.permissions])).toEqual([
      ['acme/a', true, true, ['p:read']],
      ['acme/tenant-only', true, true, []],
      ['acme/nothing', false, false, []],
    ]);
    expect(peerSwitchedOff(sql, 'acme/a')).toBe(true);
    expect(peerSwitchedOff(sql, 'acme/tenant-only')).toBe(true);
    expect(peerSwitchedOff(sql, 'acme/nothing')).toBe(false);
  });

  it('#2029: a wire carry names nothing to switch only when it names neither kind', () => {
    expect(recordedOffFromWire({})).toBeUndefined();
    expect(recordedOffFromWire({ switchedOff: [], switchedOffPeers: [] })).toBeUndefined();
    expect(recordedOffFromWire({ switchedOffPeers: ['acme/a'], tenantHeldPeers: ['acme/a'] })).toEqual({
      moduleIds: [],
      tenantHeld: undefined,
      verticals: ['acme/a'],
      tenantHeldVerticals: ['acme/a'],
    });
  });
});

describe('tenantHoldsGrant (#1823)', () => {
  const T = 't1';
  const M = '@m/x';
  const NOW = '2026-09-21T10:00:00.000Z';
  const fresh = () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE _substrat_tenant_tuples (
      tenant_id TEXT NOT NULL, subject TEXT NOT NULL, relation TEXT NOT NULL, object TEXT NOT NULL,
      expires_at TEXT, revoked_at TEXT, PRIMARY KEY (tenant_id, subject, relation, object)
    )`);
    const sql: SwitchSql = {
      all: (q, ...p) => db.prepare(q).all(...p) as Record<string, unknown>[],
      run: (q, ...p) => {
        db.prepare(q).run(...p);
      },
    };
    const put = (row: { tenant?: string; subject?: string; relation?: string; object?: string; expires?: string | null; revoked?: string | null }) =>
      db
        .prepare(`INSERT OR REPLACE INTO _substrat_tenant_tuples VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          row.tenant ?? T,
          row.subject ?? `system:${M}`,
          row.relation ?? 'granted:x:run',
          row.object ?? `tenant:${row.tenant ?? T}`,
          row.expires ?? null,
          row.revoked ?? null,
        );
    return { sql, put };
  };

  it('a live tenant-level grant holds; nothing, of course, does not', () => {
    const { sql, put } = fresh();
    expect(tenantHoldsGrant(sql, 'system', T, M, NOW)).toBe(false);
    put({});
    expect(tenantHoldsGrant(sql, 'system', T, M, NOW)).toBe(true);
  });

  it('#2030: a peer’s tenant grant is asked for as `vertical:<slug>`, never as a module', () => {
    const { sql, put } = fresh();
    put({ subject: 'vertical:acme/a' });
    expect(tenantHoldsGrant(sql, 'peer', T, 'acme/a', NOW)).toBe(true);
    expect(tenantHoldsGrant(sql, 'system', T, 'acme/a', NOW)).toBe(false);
    expect(tenantHoldsGrant(sql, 'peer', T, M, NOW)).toBe(false);
  });

  it('only a live grant of THIS module, tenant and tenant node counts', () => {
    const { sql, put } = fresh();
    put({ revoked: '2026-01-01T00:00:00.000Z' });
    put({ relation: 'granted:x:old', expires: '2026-01-01T00:00:00.000Z' });
    put({ subject: 'system:@m/other' });
    put({ tenant: 't2' });
    put({ relation: 'role:admin' });
    expect(tenantHoldsGrant(sql, 'system', T, M, NOW)).toBe(false);
    put({ relation: 'granted:x:later', expires: '2027-01-01T00:00:00.000Z' });
    expect(tenantHoldsGrant(sql, 'system', T, M, NOW)).toBe(true);
  });
});

/**
 * #1674: the status read's enumerator, against the same raw SQLite the switch itself
 * runs on. The three public states — `on`, `off`, `ungranted` — plus the one it must
 * NOT report: a module this scope never touched at all.
 */
describe('systemGrantsStatus (#1674)', () => {
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
  const grant = (db: DatabaseSync, moduleId: string, permission: string, revokedAt: string | null = null) =>
    db
      .prepare(`INSERT OR REPLACE INTO _substrat_tuples VALUES (?, ?, ?, NULL, ?)`)
      .run(`system:${moduleId}`, `granted:${permission}`, `scope:${S}`, revokedAt);

  it('reports a live grant as `on`', () => {
    const { db, sql } = fresh();
    grant(db, '@m/on', 'a:run');
    expect(systemGrantsStatus(sql, '2026-09-21T12:00:00.000Z')).toEqual([{ moduleId: '@m/on', schedules: 'on' }]);
  });

  it('reports a switched-off module as `off`, even with its grant tombstoned and no live `granted:` row', () => {
    const { db, sql } = fresh();
    grant(db, '@m/off', 'a:run');
    switchSystemSchedules(sql, { moduleId: '@m/off', scopeId: S, to: 'off', at: '2026-09-21T10:00:00.000Z' });
    expect(systemGrantsStatus(sql, '2026-09-21T12:00:00.000Z')).toEqual([{ moduleId: '@m/off', schedules: 'off' }]);
  });

  it('reports `ungranted` for a module whose only row is a REVOKED grant and no marker — enumerated, not hidden', () => {
    const { db, sql } = fresh();
    // A grant revoked on its own (a raw write, or #1659's re-grant guarantee applied to a
    // permission that was never re-granted) — no switch was ever pulled, so there is no
    // marker. The enumeration SELECT has no `revoked_at IS NULL` filter (unlike
    // `systemScheduleState`'s own EXISTS checks), so this subject is still picked up; it is
    // `systemScheduleState`, run per subject, that classifies it as `ungranted` rather than
    // silently agreeing with the enumeration's looser WHERE clause.
    grant(db, '@m/historical', 'a:run', '2026-09-01T00:00:00.000Z');
    expect(systemGrantsStatus(sql, '2026-09-21T12:00:00.000Z')).toEqual([
      { moduleId: '@m/historical', schedules: 'ungranted' },
    ]);
  });

  it('reports `ungranted` for a module whose only live grant has EXPIRED — enumerated, not hidden', () => {
    const { db, sql } = fresh();
    db.prepare(`INSERT INTO _substrat_tuples (subject, relation, object, expires_at, revoked_at) VALUES (?, ?, ?, ?, NULL)`).run(
      'system:@m/expired',
      'granted:a:run',
      `scope:${S}`,
      '2026-09-01T00:00:00.000Z',
    );
    expect(systemGrantsStatus(sql, '2026-09-21T12:00:00.000Z')).toEqual([
      { moduleId: '@m/expired', schedules: 'ungranted' },
    ]);
  });

  it('omits a module this scope never touched at all — no grant, ever, and no marker', () => {
    const { sql } = fresh();
    expect(systemGrantsStatus(sql, '2026-09-21T12:00:00.000Z')).toEqual([]);
  });

  it('enumerates several modules together, each classified independently', () => {
    const { db, sql } = fresh();
    grant(db, '@m/on', 'a:run');
    grant(db, '@m/off', 'a:run');
    switchSystemSchedules(sql, { moduleId: '@m/off', scopeId: S, to: 'off', at: '2026-09-21T10:00:00.000Z' });
    grant(db, '@m/historical', 'a:run', '2026-09-01T00:00:00.000Z');
    expect(systemGrantsStatus(sql, '2026-09-21T12:00:00.000Z')).toEqual([
      { moduleId: '@m/historical', schedules: 'ungranted' },
      { moduleId: '@m/off', schedules: 'off' },
      { moduleId: '@m/on', schedules: 'on' },
    ]);
  });
});

describe('the grant refusal wording (#1743)', () => {
  it('a scope-level refusal names its scope, and says nothing about the tenant', () => {
    const m = systemSwitchedOffMessage('@m/x', 's1');
    expect(m).toMatch(/^module '@m\/x' is switched off on scope s1 \(#1666\) — restore it first/);
    expect(m).not.toMatch(/tenant-level/);
  });

  it('a tenant-level refusal uses the same wording, naming every scope up to five and counting the rest', () => {
    expect(tenantSystemSwitchedOffMessage('@m/x', ['s1'])).toMatch(/switched off on scope s1 \(#1666\)/);
    const two = tenantSystemSwitchedOffMessage('@m/x', ['s1', 's2']);
    expect(two).toMatch(/switched off on scopes s1, s2 \(#1666\) — restore it first/);
    expect(two).toMatch(/a tenant-level grant reaches every scope of the tenant/);
    const seven = tenantSystemSwitchedOffMessage('@m/x', ['s1', 's2', 's3', 's4', 's5', 's6', 's7']);
    expect(seven).toMatch(/scopes s1, s2, s3, s4, s5 and 2 more \(#1666\)/);
    expect(seven).not.toContain('s6');
  });
});
