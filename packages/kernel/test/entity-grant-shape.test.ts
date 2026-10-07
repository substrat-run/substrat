import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { principalId, type PrincipalId } from '@substrat-run/contracts';
import { errorCodeOf } from '@substrat-run/contracts';
import { assertDelegable, grantEntityShapeIn, shapeTopUpBatch, topUpEntityGrantShapes, ulid, type SwitchSql } from '../src/index.js';

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
    // A pass, answered by the events it wrote: each top-up and each retirement is one, so they
    // are what it did.
    const events = () => (db.prepare('SELECT count(*) AS n FROM _substrat_outbox').get() as { n: number }).n;
    const run = (shapes: unknown[], limit = 500) => {
      const before = events();
      const result = topUpEntityGrantShapes(sql, {
        tenantId: T,
        scopeId: S,
        shapes: shapes as never,
        now: NOW,
        limit,
        mintEventId: () => ulid(),
        version: 'v-test',
      });
      const rows = db.prepare('SELECT type, payload FROM _substrat_outbox ORDER BY rowid LIMIT -1 OFFSET ?').all(before) as {
        type: string;
        payload: string;
      }[];
      const of = (type: string) => rows.filter((r) => r.type === type).map((r) => JSON.parse(r.payload));
      const toppedUp = of('entity.grants-topped-up') as { principal: string; entity: unknown; added: string[] }[];
      const retired = of('entity.grants-retired') as { principal: string; entity: unknown; removed: string[] }[];
      expect(rows).toHaveLength(toppedUp.length + retired.length);
      expect(result).toMatchObject({ toppedUp: toppedUp.length, retired: retired.length });
      return { toppedUp, retired, done: result.done };
    };
    const pass = (shapes: unknown[], limit = 500) => run(shapes, limit).toppedUp;
    const topUp = (permissions = GROWN, limit?: number) => pass([{ entityType: 'employee', permissions, bootstrap: true }], limit);
    return { db, sql, keysOf, shape, tuple, topUp, pass, run };
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
    expect(t.pass([{ entityType: 'emp', permissions: GROWN, bootstrap: true }])).toEqual([]);
  });

  /**
   * A SHARING shape (no `bootstrap`) is reached through `ctx.grant`, so a person holding all of
   * it is a sharee. Reconciling it would mark them a holder and hand them what the shape gains.
   */
  describe('a sharing shape is never reconciled', () => {
    const sharing = (permissions: string[]) => [{ entityType: 'employee', permissions }];

    it('a marked holder is not topped up through it', () => {
      const t = fresh();
      const anna = who();
      t.shape(anna, 'e1');
      expect(t.pass(sharing(GROWN))).toEqual([]);
      expect(t.keysOf(anna, 'e1')).toEqual(OLD);
    });

    it('a full sharee is not backfilled by it, so a later bootstrap pass of the grown shape does not reach them', () => {
      const t = fresh();
      const sharee = who();
      for (const k of OLD) t.tuple(sharee, `granted:${k}`, 'e1');
      t.pass(sharing(OLD));
      expect(t.db.prepare("SELECT count(*) AS n FROM _substrat_tuples WHERE relation = 'bootstrap'").get()).toEqual({ n: 0 });
      expect(t.pass(sharing(GROWN))).toEqual([]);
      expect(t.keysOf(sharee, 'e1')).toEqual(OLD);
    });

    it('beside a bootstrap shape in the same call, only the bootstrap one is topped up', () => {
      const t = fresh();
      const anna = who();
      t.shape(anna, 'e1');
      const list = who();
      t.db.prepare('INSERT INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)').run(`principal:${list}`, 'bootstrap', 'list:l1');
      expect(
        t.pass([
          { entityType: 'employee', permissions: GROWN, bootstrap: true },
          { entityType: 'list', permissions: ['list:contribute'] },
        ]).map((u) => u.principal),
      ).toEqual([anna]);
    });
  });

  /**
   * The backfill marks people granted before markers existed — from PROVENANCE, the shape's
   * declared `holder`, never from which keys someone holds (Codex on #2081: with a one-key shape,
   * a delegated grant of that key IS the whole shape).
   */
  describe('the backfill: people granted before markers existed', () => {
    const markers = (t: ReturnType<typeof fresh>) =>
      (t.db.prepare("SELECT subject, object FROM _substrat_tuples WHERE relation = 'bootstrap' ORDER BY subject, object").all() as {
        subject: string;
        object: string;
      }[]).map((r) => `${r.subject} ${r.object}`);
    const own = (permissions: string[], limit?: number) => (t: ReturnType<typeof fresh>) =>
      t.pass([{ entityType: 'owner', permissions, bootstrap: true, holder: 'self' }], limit);
    const ownTuple = (t: ReturnType<typeof fresh>, who: PrincipalId, key: string, ownerId: string, revokedAt: string | null = null) =>
      t.db
        .prepare('INSERT INTO _substrat_tuples (subject, relation, object, revoked_at) VALUES (?, ?, ?, ?)')
        .run(`principal:${who}`, `granted:${key}`, `owner:${ownerId}`, revokedAt);

    describe("holder: 'self' — the entity id is the principal", () => {
      it('a person holding a key of the shape on their OWN record is marked, and topped up when it grows', () => {
        const t = fresh();
        const anna = who();
        ownTuple(t, anna, 'list:manage', anna);
        expect(own(['list:manage'])(t)).toEqual([]);
        expect(markers(t)).toEqual([`principal:${anna} owner:${anna}`]);
        expect(own(['list:manage', 'list:trash'])(t).map((u) => u.added)).toEqual([['list:trash']]);
      });

      it('a one-key grant DELEGATED on someone else’s record is not marked — though it is the whole shape', () => {
        const t = fresh();
        const [anna, bo] = [who(), who()];
        ownTuple(t, bo, 'list:manage', anna); // bo was ctx.granted anna's owner key
        own(['list:manage'])(t);
        expect(markers(t)).toEqual([]);
        expect(own(['list:manage', 'list:trash'])(t)).toEqual([]);
      });

      it('a tombstoned key on their own record is evidence they were given it, and stays tombstoned', () => {
        const t = fresh();
        const anna = who();
        ownTuple(t, anna, 'list:manage', anna, NOW);
        own(['list:manage'])(t);
        expect(markers(t)).toEqual([`principal:${anna} owner:${anna}`]);
        expect(own(['list:manage', 'list:trash'])(t).map((u) => u.added)).toEqual([['list:trash']]);
      });

      it('the shape may grow in the same release that adopts markers: the backfill reads no key set', () => {
        const t = fresh();
        const anna = who();
        ownTuple(t, anna, 'list:manage', anna);
        expect(own(['list:manage', 'list:trash'])(t).map((u) => u.added)).toEqual([['list:trash']]);
      });
    });

    describe('holder: a column of the vertical’s own table', () => {
      const shape = (permissions = GROWN, limit?: number) => (t: ReturnType<typeof fresh>) =>
        t.pass(
          [{ entityType: 'employee', permissions, bootstrap: true, holder: { table: 'hr_employees', idColumn: 'id', principalColumn: 'principal_ref' } }],
          limit,
        );
      const employees = (t: ReturnType<typeof fresh>, rows: [string, string | null][]) => {
        t.db.exec('CREATE TABLE IF NOT EXISTS hr_employees (id TEXT PRIMARY KEY, principal_ref TEXT)');
        for (const [id, p] of rows) t.db.prepare('INSERT INTO hr_employees (id, principal_ref) VALUES (?, ?)').run(id, p);
      };

      it('the person the record names is marked; a manager granted the whole shape on it is not', () => {
        const t = fresh();
        const [anna, manager] = [who(), who()];
        employees(t, [['e1', anna]]);
        t.tuple(anna, 'granted:emp:read', 'e1');
        for (const k of OLD) t.tuple(manager, `granted:${k}`, 'e1');
        expect(shape()(t).map((u) => u.principal)).toEqual([anna]);
        expect(markers(t)).toEqual([`principal:${anna} employee:e1`]);
        expect(t.keysOf(manager, 'e1')).toEqual(OLD);
      });

      it('a record with no principal, or whose principal holds nothing there, marks nobody', () => {
        const t = fresh();
        const anna = who();
        employees(t, [['e1', null], ['e2', anna]]);
        shape()(t);
        expect(markers(t)).toEqual([]);
      });

      it('a missing table leaves the backfill open, and it runs once the table exists', () => {
        const t = fresh();
        const anna = who();
        t.tuple(anna, 'granted:emp:read', 'e1');
        expect(shape()(t)).toEqual([]);
        employees(t, [['e1', anna]]);
        expect(shape()(t).map((u) => u.principal)).toEqual([anna]);
      });
    });

    it('a bootstrap shape with no `holder` gets no backfill: only people given it from now on', () => {
      const t = fresh();
      const anna = who();
      for (const k of OLD) t.tuple(anna, `granted:${k}`, 'e1');
      expect(t.topUp()).toEqual([]);
      expect(markers(t)).toEqual([]);
    });

    it('is bounded by the pass budget, resumes from the markers, and is recorded done on a short batch', () => {
      const t = fresh();
      const people = [0, 1, 2, 3, 4].map(() => who());
      for (const p of people) ownTuple(t, p, 'list:manage', p);
      const counts: number[] = [];
      for (let i = 0; i < 4; i++) {
        own(['list:manage'], 2)(t);
        counts.push(markers(t).length);
      }
      expect(counts).toEqual([2, 4, 5, 5]);
      // Done: a person granted on their own record AFTER it finished is not swept in.
      const late = who();
      ownTuple(t, late, 'list:manage', late);
      own(['list:manage'])(t);
      expect(markers(t)).toHaveLength(5);
    });

    describe("holder: 'grantee' — whoever holds a key of it on that type (#2083)", () => {
      const PORTAL = ['conv:read-own'];
      const portal = (permissions = PORTAL) => (t: ReturnType<typeof fresh>) =>
        t.pass([{ entityType: 'contact', permissions, bootstrap: true, holder: 'grantee' }]);
      const contactTuple = (t: ReturnType<typeof fresh>, p: PrincipalId, key: string, id: string, revokedAt: string | null = null) =>
        t.db
          .prepare('INSERT INTO _substrat_tuples (subject, relation, object, revoked_at) VALUES (?, ?, ?, ?)')
          .run(`principal:${p}`, `granted:${key}`, `contact:${id}`, revokedAt);

      it('every person holding a live key of it on a record of that type is marked — several on one record too', () => {
        const t = fresh();
        const [anna, bo] = [who(), who()];
        contactTuple(t, anna, 'conv:read-own', 'c1');
        contactTuple(t, bo, 'conv:read-own', 'c1');
        portal()(t);
        expect(markers(t)).toEqual([`principal:${anna} contact:c1`, `principal:${bo} contact:c1`].sort());
        // ...so a pre-existing holder receives the key the shape gains.
        expect(portal(['conv:read-own', 'conv:reply-own'])(t).map((u) => u.added)).toEqual([['conv:reply-own'], ['conv:reply-own']]);
      });

      it('a key taken back is no evidence: a person whose only key is tombstoned is not marked, and gains nothing', () => {
        const t = fresh();
        const anna = who();
        contactTuple(t, anna, 'conv:read-own', 'c1', NOW);
        portal()(t);
        expect(markers(t)).toEqual([]);
        expect(portal(['conv:read-own', 'conv:reply-own'])(t)).toEqual([]);
      });

      it('a key of another type, or another key on this type, marks nobody', () => {
        const t = fresh();
        const anna = who();
        contactTuple(t, anna, 'contact:read', 'c1');
        t.tuple(anna, 'granted:conv:read-own', 'e1'); // the shape's key, on an employee
        portal()(t);
        expect(markers(t)).toEqual([]);
      });

      it('a live retired key finds a legacy holder, then retirement and top-up both apply', () => {
        const t = fresh();
        const anna = who();
        contactTuple(t, anna, 'conv:read-own', 'c1');
        expect(t.run([{ entityType: 'contact', permissions: ['conv:reply-own'], retired: ['conv:read-own'], bootstrap: true, holder: 'grantee' }])).toEqual({
          retired: [{ principal: anna, entity: { entityType: 'contact', entityId: 'c1' }, removed: ['conv:read-own'] }],
          toppedUp: [{ principal: anna, entity: { entityType: 'contact', entityId: 'c1' }, added: ['conv:reply-own'] }],
          done: true,
        });
        expect(t.db.prepare("SELECT relation, revoked_at FROM _substrat_tuples WHERE subject = ? AND object = ? AND relation LIKE 'granted:%' ORDER BY relation").all(`principal:${anna}`, 'contact:c1')).toEqual([
          { relation: 'granted:conv:read-own', revoked_at: NOW },
          { relation: 'granted:conv:reply-own', revoked_at: null },
        ]);
      });
    });
  });

  describe("a 'grantee' shape's keys are the shape grant's alone (#2083)", () => {
    const grantee = { entityType: 'contact', permissions: ['conv:read-own'], bootstrap: true, holder: 'grantee' };
    const contact = { entityType: 'contact', entityId: 'c1' };
    const refusal = (t: ReturnType<typeof fresh>, key: string, entity: { entityType: string; entityId: string } = contact) => {
      const sql: SwitchSql = { all: (q, ...p) => t.db.prepare(q).all(...p) as Record<string, unknown>[], run: () => undefined };
      try {
        assertDelegable(sql, key, entity);
        return 'grantable';
      } catch (e) {
        return errorCodeOf(e);
      }
    };

    it('ctx.grant is refused a key of it on that entity type once a pass has carried the declaration', () => {
      const t = fresh();
      expect(refusal(t, 'conv:read-own')).toBe('grantable'); // before any reconcile: nothing declared here yet
      t.pass([grantee]);
      expect(refusal(t, 'conv:read-own')).toBe('permission_denied');
    });

    it('...while another key on the same type, and the same key on another type, stay grantable', () => {
      const t = fresh();
      t.pass([grantee]);
      expect(refusal(t, 'contact:read')).toBe('grantable');
      expect(refusal(t, 'conv:read-own', { entityType: 'conversation', entityId: 'v1' })).toBe('grantable');
    });

    it('a shape with any other holder, or a sharing shape, refuses nothing', () => {
      const t = fresh();
      t.pass([
        { ...grantee, holder: 'self' },
        { entityType: 'contact', permissions: ['conv:read-own'] },
      ]);
      expect(refusal(t, 'conv:read-own')).toBe('grantable');
    });

    it('the records follow the registry each pass carries: a declaration dropped, or a key dropped, stops refusing', () => {
      const t = fresh();
      t.pass([{ ...grantee, permissions: ['conv:read-own', 'conv:reply-own'] }]);
      expect(refusal(t, 'conv:reply-own')).toBe('permission_denied');
      t.pass([grantee]);
      expect([refusal(t, 'conv:read-own'), refusal(t, 'conv:reply-own')]).toEqual(['permission_denied', 'grantable']);
      t.pass([{ ...grantee, holder: undefined }]);
      expect(refusal(t, 'conv:read-own')).toBe('grantable');
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

  it('a key dropped from the shape and NOT declared retired is left where it is', () => {
    const t = fresh();
    const anna = who();
    t.shape(anna, 'e1');
    expect(t.topUp(['emp:read'])).toEqual([]);
    expect(t.keysOf(anna, 'e1')).toEqual(OLD);
  });

  /**
   * #2082: a key the shape declares `retired` is taken back from every holder — tombstoned, once
   * per scope, one event per (person, entity). Only a holder's own row of that key on the
   * entity the marker is on; one tuple is one authority, so a direct grant of the same key there
   * goes with it.
   */
  describe('a key the shape retires is taken back from its holders (#2082)', () => {
    const CANCEL = 'emp:cancel';
    const retiring = (permissions = OLD, retired = [CANCEL]) => [{ entityType: 'employee', permissions, bootstrap: true, retired }];
    const retire = (t: ReturnType<typeof fresh>, limit?: number, permissions?: string[]) => t.run(retiring(permissions), limit);
    const row = (t: ReturnType<typeof fresh>, who: PrincipalId, relation: string, object: string) =>
      t.db.prepare('SELECT revoked_at FROM _substrat_tuples WHERE subject = ? AND relation = ? AND object = ?').get(`principal:${who}`, relation, object) as
        | { revoked_at: string | null }
        | undefined;

    it('a holder loses the retired key there — tombstoned, not deleted — and keeps the rest of the shape', () => {
      const t = fresh();
      const anna = who();
      t.shape(anna, 'e1', GROWN);
      expect(retire(t)).toEqual({
        toppedUp: [],
        retired: [{ principal: anna, entity: { entityType: 'employee', entityId: 'e1' }, removed: [CANCEL] }],
        done: true,
      });
      expect(t.keysOf(anna, 'e1')).toEqual(OLD);
      expect(row(t, anna, `granted:${CANCEL}`, 'employee:e1')).toEqual({ revoked_at: NOW });
    });

    it('each retirement is one kernel event on the entity, stamped with the deploy and no operation', () => {
      const t = fresh();
      t.shape(who(), 'e1', [...GROWN, 'emp:sign']);
      retire(t, undefined, OLD);
      t.run(retiring(OLD, [CANCEL, 'emp:sign']));
      expect(t.db.prepare('SELECT type, entity_type, entity_id, actor, operation, authorization, version, payload FROM _substrat_outbox').all()).toEqual([
        expect.objectContaining({
          type: 'entity.grants-retired',
          entity_type: 'employee',
          entity_id: 'e1',
          actor: JSON.stringify({ system: '@substrat-run/kernel' }),
          operation: null,
          authorization: null,
          version: 'v-test',
        }),
        expect.objectContaining({ type: 'entity.grants-retired' }),
      ]);
    });

    it('several retired keys of one holder are one event naming them all', () => {
      const t = fresh();
      const anna = who();
      t.shape(anna, 'e1', [...GROWN, 'emp:sign']);
      expect(t.run(retiring(OLD, ['emp:sign', CANCEL])).retired.map((r) => r.removed)).toEqual([[CANCEL, 'emp:sign']]);
      expect(t.keysOf(anna, 'e1')).toEqual(OLD);
    });

    it('the key held any other way stays: a non-holder on the same entity, the holder on another entity or a parent', () => {
      const t = fresh();
      const [anna, manager, bo] = [who(), who(), who()];
      t.shape(anna, 'e1', GROWN);
      t.tuple(manager, `granted:${CANCEL}`, 'e1'); // ctx.granted on anna's record: not a holder
      t.tuple(bo, `granted:${CANCEL}`, 'e2'); // ctx.granted, no shape at all
      t.tuple(anna, `granted:${CANCEL}`, 'e9'); // anna, on an entity she does not hold the shape on
      t.db.prepare('INSERT INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)').run(`principal:${anna}`, `granted:${CANCEL}`, 'dept:d1');
      expect(retire(t).retired.map((r) => r.principal)).toEqual([anna]);
      expect(t.keysOf(manager, 'e1')).toEqual([CANCEL]);
      expect(t.keysOf(bo, 'e2')).toEqual([CANCEL]);
      expect(t.keysOf(anna, 'e9')).toEqual([CANCEL]);
      expect(row(t, anna, `granted:${CANCEL}`, 'dept:d1')).toEqual({ revoked_at: null });
    });

    it('one tuple is one authority: a direct grant of the key to the holder on the same entity goes too', () => {
      const t = fresh();
      const anna = who();
      t.shape(anna, 'e1', OLD); // given the shape without the key...
      t.tuple(anna, `granted:${CANCEL}`, 'e1'); // ...and ctx.granted it there separately: the same row
      expect(retire(t).retired.map((r) => r.removed)).toEqual([[CANCEL]]);
      expect(t.keysOf(anna, 'e1')).toEqual(OLD);
    });

    it('a holder whose marker is tombstoned is not a holder, and keeps the key', () => {
      const t = fresh();
      const [anna, bo] = [who(), who()];
      t.shape(anna, 'e1', GROWN);
      t.shape(bo, 'e2', GROWN);
      t.tuple(anna, 'bootstrap', 'e1', NOW);
      expect(retire(t).retired.map((r) => r.principal)).toEqual([bo]);
      expect(t.keysOf(anna, 'e1')).toEqual(GROWN.slice().sort());
    });

    it('runs once per scope: the key granted to a holder again after it finished is left alone', () => {
      const t = fresh();
      const anna = who();
      t.shape(anna, 'e1', GROWN);
      expect(retire(t).retired).toHaveLength(1);
      t.tuple(anna, `granted:${CANCEL}`, 'e1'); // granted back, explicitly
      expect(retire(t)).toEqual({ toppedUp: [], retired: [], done: true });
      expect(t.keysOf(anna, 'e1')).toContain(CANCEL);
    });

    it('a pass retires at most `limit` holders; repeated passes reach each exactly once', () => {
      const t = fresh();
      const people = [0, 1, 2, 3, 4].map((i) => {
        const p = who();
        t.shape(p, `e${i}`, GROWN);
        return p;
      });
      const passes = [0, 1, 2, 3].map(() => retire(t, 2)).map((r) => [r.retired.length, r.done]);
      expect(passes).toEqual([[2, false], [2, false], [1, true], [0, true]]);
      for (const [i, p] of people.entries()) expect(t.keysOf(p, `e${i}`)).toEqual(OLD);
    });

    it('a retirement and a top-up in one pass share its budget', () => {
      const t = fresh();
      for (const i of [0, 1, 2]) t.shape(who(), `e${i}`, GROWN);
      const grown = [...OLD, 'emp:sign'];
      const first = retire(t, 4, grown);
      expect([first.retired.length, first.toppedUp.length, first.done]).toEqual([3, 1, false]);
      const second = retire(t, 4, grown);
      expect([second.retired.length, second.toppedUp.length, second.done]).toEqual([0, 2, true]);
    });

    it('putting the key back reaches only new shape grants; retiring it again runs again', () => {
      const t = fresh();
      const anna = who();
      t.shape(anna, 'e1', GROWN);
      retire(t);
      // Back in the shape: anna's tombstone is a revoke the top-up never undoes.
      expect(t.topUp(GROWN)).toEqual([]);
      expect(t.keysOf(anna, 'e1')).toEqual(OLD);
      const bo = who();
      t.shape(bo, 'e2', GROWN);
      expect(t.keysOf(bo, 'e2')).toContain(CANCEL);
      // Retired again in a later release: the first record ended, so this one runs.
      expect(retire(t).retired.map((r) => r.principal)).toEqual([bo]);
      expect(t.keysOf(bo, 'e2')).toEqual(OLD);
    });

    it('a key the shape still grants is never taken back, whatever `retired` says', () => {
      const t = fresh();
      const anna = who();
      t.shape(anna, 'e1', GROWN);
      expect(t.run(retiring(GROWN, [CANCEL])).retired).toEqual([]);
      expect(t.keysOf(anna, 'e1')).toContain(CANCEL);
    });

    it('a sharing shape retires nothing, even for a marked holder', () => {
      const t = fresh();
      const anna = who();
      t.shape(anna, 'e1', GROWN);
      expect(t.run([{ entityType: 'employee', permissions: OLD, retired: [CANCEL] }]).retired).toEqual([]);
      expect(t.keysOf(anna, 'e1')).toContain(CANCEL);
    });

    it('the backfill counts a retired key as evidence: an old owner is marked, retired and topped up in one pass', () => {
      const t = fresh();
      const anna = who();
      t.db.prepare('INSERT INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)').run(`principal:${anna}`, 'granted:list:old', `owner:${anna}`);
      const r = t.run([{ entityType: 'owner', permissions: ['list:manage'], bootstrap: true, holder: 'self', retired: ['list:old'] }]);
      expect([r.retired.map((x) => x.removed), r.toppedUp.map((x) => x.added)]).toEqual([[['list:old']], [['list:manage']]]);
    });
  });

  /** A pass with no budget never reports done: a loop waiting for it would never end. */
  describe('the batch is a positive integer no larger than 5000', () => {
    it.each([0, -1, 1.5, 5001, Number.NaN])('refuses %s with validation_failed', (batch) => {
      expect(errorCodeOf((() => { try { shapeTopUpBatch(batch); } catch (e) { return e; } })())).toBe('validation_failed');
      const t = fresh();
      expect(() => t.topUp(GROWN, batch)).toThrow(/batch must be an integer/);
    });

    it.each([1, 500, 5000])('accepts %s', (batch) => {
      expect(shapeTopUpBatch(batch)).toBe(batch);
    });

    it('defaults to 500', () => {
      expect(shapeTopUpBatch()).toBe(500);
    });
  });
});
