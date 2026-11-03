import { describe, expect, it } from 'vitest';
import { assertReplayableDump, type ScopeDumpObject } from '../src/index.js';

/**
 * #2820: a module table's own indexes and triggers ride in the dump and come back with a restore.
 * Every object is judged before anything is replayed: a malformed one refuses the dump; anything
 * a restore does not put back is left out and named, so a restore stays possible.
 */
const LEDGER = 'CREATE TABLE ledger (id TEXT PRIMARY KEY, who TEXT, lead INTEGER)';
const dump = (...objects: ScopeDumpObject[]) => [
  { name: 'ledger', ddl: LEDGER, columns: ['id', 'who', 'lead'], objects },
  { name: 'other', ddl: 'CREATE TABLE other (id TEXT)', columns: ['id'], objects: [] as ScopeDumpObject[] },
];
const index = (name: string, ddl: string): ScopeDumpObject => ({ type: 'index', name, ddl });
const trigger = (name: string, ddl: string): ScopeDumpObject => ({ type: 'trigger', name, ddl });
const guard = (name: string, body: string, when = '') =>
  trigger(name, `CREATE TRIGGER ${name} BEFORE DELETE ON ledger${when} BEGIN ${body} END`);

const ONE_LEAD = index('ledger_one_lead', 'CREATE UNIQUE INDEX ledger_one_lead ON ledger (who) WHERE lead = 1');
const NO_UPDATE = trigger(
  'ledger_no_update',
  "CREATE TRIGGER ledger_no_update BEFORE UPDATE OF who, lead ON ledger FOR EACH ROW WHEN OLD.id IS NOT NULL\n" +
    "BEGIN SELECT RAISE(ABORT, 'ledger is append-only; END here is text'); SELECT RAISE(FAIL, 'no') WHERE NEW.lead = 2; END",
);
// The common append-only idiom; a change test; and `main.` where SQLite's grammar takes it, kept as written.
const NO_DELETE = guard('ledger_no_delete', "SELECT CASE WHEN OLD.lead IN (0, 1) THEN RAISE(ROLLBACK, 'kept') END;");
const NO_MOVE = trigger(
  'ledger_no_move',
  "CREATE TRIGGER ledger_no_move BEFORE UPDATE ON main.ledger WHEN NEW.who IS DISTINCT FROM OLD.who BEGIN SELECT RAISE(ABORT, 'kept'); END",
);
const MAIN = index('ledger_by_who', 'CREATE INDEX main.ledger_by_who ON ledger (who)');

describe('assertReplayableDump: the objects a dump carries', () => {
  it('puts back an index and the guard trigger shapes', () => {
    const shapes = [ONE_LEAD, NO_UPDATE, NO_DELETE, NO_MOVE, MAIN];
    expect(assertReplayableDump(dump(...shapes))).toEqual({ replay: shapes.map((o) => ({ ...o, table: 'ledger' })), skipped: [], carried: 5 });
  });

  it('reads a dump written before objects were carried as not carrying them', () => {
    const legacy = dump().map((t) => ({ ...t, objects: undefined }));
    expect(assertReplayableDump(legacy)).toEqual({ replay: [], skipped: [], carried: null });
  });

  // Left out and named, never refused: a restore stays possible whatever a module wrote.
  const skipped: [string, ScopeDumpObject][] = [
    ['a trigger that writes', trigger('t1', "CREATE TRIGGER t1 AFTER INSERT ON ledger BEGIN UPDATE other SET id = 'x'; END")],
    ['a kind this reader does not know', { type: 'view', name: 't1', ddl: 'CREATE VIEW t1 AS SELECT * FROM ledger' }],
    ['a RAISE(IGNORE), which would let the write pass silently', guard('t1', 'SELECT RAISE(IGNORE);')],
    ['a guard whose WHEN reads other rows', guard('t1', "SELECT RAISE(ABORT, 'no');", ' WHEN (SELECT COUNT(*) FROM other) > 0')],
    ['a guard whose body reads other rows', guard('t1', "SELECT RAISE(ABORT, 'no') WHERE EXISTS (SELECT 1 FROM other);")],
    ['a guard reading through a CTE', guard('t1', "WITH x AS (SELECT 1) SELECT RAISE(ABORT, 'no');")],
    ['a guard reading FROM another table', guard('t1', "SELECT RAISE(ABORT, 'no') FROM other;")],
    ['a guard whose WHEN tests IN a table', guard('t1', "SELECT RAISE(ABORT, 'no');", ' WHEN OLD.id IN other')],
    ['a guard whose message is not one string literal', guard('t1', 'SELECT RAISE(ABORT, OLD.id);')],
    ['a body of VALUES', guard('t1', 'VALUES (1);')],
    ['a name SQLite reads with a character outside ASCII', index('t1', 'CREATE INDEX t1é ON ledger (who)')],
    ['a quoted name that is not a plain identifier', index('by-who', 'CREATE INDEX "by-who" ON ledger (who)')],
    ['a trigger named as its table', guard('ledger', "SELECT RAISE(ABORT, 'no');")],
  ];
  for (const [what, object] of skipped) {
    it(`leaves out and names ${what}`, () => {
      expect(assertReplayableDump(dump(ONE_LEAD, object))).toMatchObject({ replay: [{ name: 'ledger_one_lead' }], skipped: [object.name], carried: 2 });
    });
  }

  it('leaves out a second object of one name', () => {
    const again = index('LEDGER_ONE_LEAD', 'CREATE INDEX LEDGER_ONE_LEAD ON ledger (id)');
    expect(assertReplayableDump(dump(ONE_LEAD, again)).skipped).toEqual(['LEDGER_ONE_LEAD']);
  });

  const refused: [string, ScopeDumpObject, RegExp][] = [
    ['a statement after a trigger body', trigger('t1', "CREATE TRIGGER t1 BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'no'); END; DROP TABLE other"), /does not end with the END/],
    ['a statement ridden inside a trigger body', trigger('t1', "CREATE TRIGGER t1 BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'no'); END; DROP TABLE other; END"), /more than one statement/],
    ['a statement before a trigger body', trigger('t1', "CREATE TRIGGER t1 BEFORE DELETE ON ledger; DROP TABLE other; CREATE TRIGGER t2 BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'no'); END"), /more than one statement/],
    ['a statement after an index', index('i1', 'CREATE INDEX i1 ON ledger (who); DROP TABLE other'), /more than one statement/],
    ['an object on another table', index('i1', 'CREATE INDEX i1 ON other (id)'), /names another table/],
    ['an object on the spine', index('i1', 'CREATE INDEX i1 ON _substrat_tuples (subject)'), /names another table/],
    ['an index on a qualified table, which SQLite does not parse', index('i1', 'CREATE INDEX i1 ON main.ledger (who)'), /names another table/],
    ['a name its own text does not give', index('i1', 'CREATE INDEX i2 ON ledger (who)'), /names another name/],
    ['a reserved name', index('_substrat_list_x', 'CREATE INDEX _substrat_list_x ON ledger (who)'), /reserved name/],
    ['a TEMP trigger', trigger('t1', "CREATE TEMP TRIGGER t1 BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'no'); END"), /shape a dump carries/],
    ['an INSTEAD OF trigger', trigger('t1', "CREATE TRIGGER t1 INSTEAD OF DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'no'); END"), /fires on no/],
    ['a trigger typed as an index', index('t1', "CREATE TRIGGER t1 BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'no'); END"), /shape a dump carries/],
  ];
  for (const [what, object, message] of refused) {
    it(`refuses ${what}`, () => {
      expect(() => assertReplayableDump(dump(object))).toThrow(message);
    });
  }

  it('refuses an object filed under a platform table', () => {
    const spine = {
      name: '_substrat_notes',
      ddl: 'CREATE TABLE _substrat_notes (id TEXT)',
      columns: ['id'],
      objects: [trigger('t1', "CREATE TRIGGER t1 BEFORE DELETE ON _substrat_notes BEGIN SELECT RAISE(ABORT, 'no'); END")],
    };
    expect(() => assertReplayableDump([spine])).toThrow(/filed under a platform table/);
  });
});
