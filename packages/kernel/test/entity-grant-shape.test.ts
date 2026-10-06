import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { principalId, type PrincipalId } from '@substrat-run/contracts';
import { grantEntityShapeIn, topUpEntityGrantShapes, ulid, type SwitchSql } from '../src/index.js';

/**
 * The declared shape's reconcile (#2071), over a bare `_substrat_tuples`. The edges the
 * contract suite drives end to end on both adapters are here one by one: who counts as a
 * holder, what a tombstone keeps, the run-once backfill, and the batch bound.
 */
describe('a declared entity-grant shape, topped up (#2071)', () => {
  const T = ulid();
  const S = ulid();
  const NOW = '2026-10-06T00:00:00.000Z';
  const OLD = ['emp:read', 'emp:report'];
  const GROWN = [...OLD, 'emp:cancel'];

  const fresh = () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE _substrat_tuples (
      subject TEXT NOT NULL, relation TEXT NOT NULL, object TEXT NOT NULL,
      expires_at TEXT, revoked_at TEXT, PRIMARY KEY (subject, relation, object)
    )`);
    db.exec(`CREATE TABLE _substrat_outbox (
      id TEXT PRIMARY KEY, type TEXT, schema_version INTEGER, occurred_at TEXT, tenant_id TEXT,
      scope_id TEXT, actor TEXT, entity_type TEXT, entity_id TEXT, pii_class TEXT, subject_id TEXT,
      authorization TEXT, impersonation TEXT, operation TEXT, version TEXT, caused_by TEXT,
      invocation_id TEXT, payload TEXT
    )`);
    const sql: SwitchSql = {
      all: (q, ...p) => db.prepare(q).all(...p) as Record<string, unknown>[],
      run: (q, ...p) => {
        db.prepare(q).run(...p);
      },
    };
    const keysOf = (who: PrincipalId, id: string) =>
      (
        db
          .prepare(
            `SELECT relation FROM _substrat_tuples WHERE subject = ? AND object = ? AND revoked_at IS NULL
              AND substr(relation, 1, 8) = 'granted:' ORDER BY relation`,
          )
          .all(`principal:${who}`, `employee:${id}`) as { relation: string }[]
      ).map((r) => r.relation.slice('granted:'.length));
    const shape = (who: PrincipalId, id: string, keys = OLD) => {
      grantEntityShapeIn(sql, who, { entityType: 'employee', entityId: id }, keys);
    };
    const tuple = (who: PrincipalId, relation: string, id: string, revokedAt: string | null = null) =>
      db
        .prepare('INSERT OR REPLACE INTO _substrat_tuples (subject, relation, object, revoked_at) VALUES (?, ?, ?, ?)')
        .run(`principal:${who}`, relation, `employee:${id}`, revokedAt);
    // A pass, answered by the events it wrote: each top-up is one, so they are what it did.
    const events = () => (db.prepare('SELECT count(*) AS n FROM _substrat_outbox').get() as { n: number }).n;
    const pass = (shapes: { entityType: string; permissions: string[] }[], limit = 500) => {
      const before = events();
      const n = topUpEntityGrantShapes(sql, {
        tenantId: T,
        scopeId: S,
        shapes: shapes as never,
        now: NOW,
        limit,
        mintEventId: () => ulid(),
        version: 'v-test',
      });
      const rows = db.prepare('SELECT payload FROM _substrat_outbox ORDER BY rowid LIMIT -1 OFFSET ?').all(before) as { payload: string }[];
      expect(rows).toHaveLength(n);
      return rows.map((r) => JSON.parse(r.payload) as { principal: string; entity: unknown; added: string[] });
    };
    const topUp = (permissions = GROWN, limit?: number) => pass([{ entityType: 'employee', permissions }], limit);
    return { db, keysOf, shape, tuple, topUp, pass };
  };
  const who = () => principalId.parse(ulid());

  it('a holder granted the old shape is given the key the shape gained, and the result says so', () => {
    const t = fresh();
    const anna = who();
    t.shape(anna, 'e1');
    expect(t.topUp()).toEqual([{ principal: anna, entity: { entityType: 'employee', entityId: 'e1' }, added: ['emp:cancel'] }]);
    expect(t.keysOf(anna, 'e1')).toEqual(['emp:cancel', 'emp:read', 'emp:report']);
  });

  it('each top-up is one kernel event on the entity, stamped with the deploy and no operation', () => {
    const t = fresh();
    t.shape(who(), 'e1');
    t.topUp();
    expect(t.db.prepare('SELECT type, entity_type, entity_id, actor, operation, authorization, version FROM _substrat_outbox').all()).toEqual([
      {
        type: 'entity.grants-topped-up',
        entity_type: 'employee',
        entity_id: 'e1',
        actor: JSON.stringify({ system: '@substrat-run/kernel' }),
        operation: null,
        authorization: null,
        version: 'v-test',
      },
    ]);
  });

  it('a second run tops up nobody', () => {
    const t = fresh();
    t.shape(who(), 'e1');
    t.topUp();
    expect(t.topUp()).toEqual([]);
  });

  it('a key revoked from the holder there stays revoked, while the other added key arrives', () => {
    const t = fresh();
    const anna = who();
    t.shape(anna, 'e1');
    t.tuple(anna, 'granted:emp:cancel', 'e1', NOW); // taken back before the shape gained it here
    expect(t.topUp([...GROWN, 'emp:sign'])).toEqual([
      { principal: anna, entity: { entityType: 'employee', entityId: 'e1' }, added: ['emp:sign'] },
    ]);
    expect(t.keysOf(anna, 'e1')).toEqual(['emp:read', 'emp:report', 'emp:sign']);
  });

  it('...and a holder whose only missing key is revoked is not topped up at all', () => {
    const t = fresh();
    const anna = who();
    t.shape(anna, 'e1');
    t.tuple(anna, 'granted:emp:cancel', 'e1', NOW);
    expect(t.topUp()).toEqual([]);
  });

  it('someone granted ONE key of the shape is not a holder, and is not escalated', () => {
    const t = fresh();
    t.topUp(); // the backfill has run: the shape is in force here
    const manager = who();
    t.tuple(manager, 'granted:emp:read', 'e1');
    expect(t.topUp()).toEqual([]);
    expect(t.keysOf(manager, 'e1')).toEqual(['emp:read']);
  });

  it('a tombstoned marker stops the top-ups for that holder; a live one beside it is topped up', () => {
    const t = fresh();
    const [anna, bo] = [who(), who()];
    t.shape(anna, 'e1');
    t.shape(bo, 'e2');
    t.tuple(anna, 'bootstrap', 'e1', NOW);
    expect(t.topUp().map((u) => u.principal)).toEqual([bo]);
    expect(t.keysOf(anna, 'e1')).toEqual(OLD);
  });

  it('the shape is matched by entity type: a marker on another type is not topped up', () => {
    const t = fresh();
    const anna = who();
    t.shape(anna, 'e1');
    expect(t.pass([{ entityType: 'emp', permissions: GROWN }])).toEqual([]);
  });

  describe('the backfill: people granted before markers existed', () => {
    it('a person holding every key of the current shape becomes a holder, and is topped up when it grows', () => {
      const t = fresh();
      const anna = who();
      for (const k of OLD) t.tuple(anna, `granted:${k}`, 'e1');
      expect(t.topUp(OLD)).toEqual([]); // the first run marks; nothing is missing yet
      expect(t.topUp(GROWN).map((u) => u.added)).toEqual([['emp:cancel']]);
    });

    it('a tombstoned key still counts toward holding the shape — and stays tombstoned', () => {
      const t = fresh();
      const anna = who();
      t.tuple(anna, 'granted:emp:read', 'e1');
      t.tuple(anna, 'granted:emp:report', 'e1', NOW);
      t.topUp(OLD);
      expect(t.topUp(GROWN).map((u) => u.added)).toEqual([['emp:cancel']]);
      expect(t.keysOf(anna, 'e1')).toEqual(['emp:cancel', 'emp:read']);
    });

    it('a person holding PART of the current shape is not made a holder', () => {
      const t = fresh();
      const anna = who();
      t.tuple(anna, 'granted:emp:read', 'e1');
      t.topUp(OLD);
      expect(t.topUp(GROWN)).toEqual([]);
    });

    it('runs once per scope and type: the whole shape granted by hand LATER makes nobody a holder', () => {
      const t = fresh();
      t.topUp(OLD);
      const anna = who();
      for (const k of OLD) t.tuple(anna, `granted:${k}`, 'e1');
      t.topUp(OLD);
      expect(t.topUp(GROWN)).toEqual([]);
    });
  });

  it('a pass tops up at most `limit` holders, and repeated passes reach everyone exactly once', () => {
    const t = fresh();
    const people = Array.from({ length: 5 }, (_, i) => {
      const p = who();
      t.shape(p, `e${i}`);
      return p;
    });
    const passes = [t.topUp(GROWN, 2), t.topUp(GROWN, 2), t.topUp(GROWN, 2), t.topUp(GROWN, 2)].map((r) => r.length);
    expect(passes).toEqual([2, 2, 1, 0]);
    for (const [i, p] of people.entries()) expect(t.keysOf(p, `e${i}`)).toEqual(['emp:cancel', 'emp:read', 'emp:report']);
  });

  it('a key dropped from the shape is left where it is: top-up only', () => {
    const t = fresh();
    const anna = who();
    t.shape(anna, 'e1');
    expect(t.topUp(['emp:read'])).toEqual([]);
    expect(t.keysOf(anna, 'e1')).toEqual(OLD);
  });
});
