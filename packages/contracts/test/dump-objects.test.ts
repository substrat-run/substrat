import { describe, expect, it } from 'vitest';
import { assertReplayableDump, type ScopeDumpObject } from '../src/index.js';

/**
 * #2820: a module table's own indexes and triggers ride in the dump and come back with a restore.
 * Every object is judged before anything is dropped: a malformed one refuses the dump, a trigger
 * that is not a guard is left out and named.
 */
const LEDGER = 'CREATE TABLE ledger (id TEXT PRIMARY KEY, who TEXT, lead INTEGER)';
const dump = (...objects: ScopeDumpObject[]) => [
  { name: 'ledger', ddl: LEDGER, columns: ['id', 'who', 'lead'], objects },
  { name: 'other', ddl: 'CREATE TABLE other (id TEXT)', columns: ['id'] },
];
const index = (name: string, ddl: string): ScopeDumpObject => ({ type: 'index', name, ddl });
const trigger = (name: string, ddl: string): ScopeDumpObject => ({ type: 'trigger', name, ddl });

const ONE_LEAD = index('ledger_one_lead', 'CREATE UNIQUE INDEX ledger_one_lead ON ledger (who) WHERE lead = 1');
const NO_UPDATE = trigger(
  'ledger_no_update',
  "CREATE TRIGGER ledger_no_update BEFORE UPDATE OF who, lead ON ledger FOR EACH ROW WHEN OLD.id IS NOT NULL\n" +
    "BEGIN SELECT RAISE(ABORT, 'ledger is append-only; END here is text'); SELECT RAISE(IGNORE) WHERE NEW.lead = 2; END",
);

describe('assertReplayableDump: the objects a dump carries', () => {
  it('puts back an index and a guard trigger, and leaves out and names a trigger that writes', () => {
    const writes = trigger('ledger_touch', "CREATE TRIGGER ledger_touch AFTER INSERT ON ledger BEGIN UPDATE other SET id = 'x'; END");
    const plan = assertReplayableDump(dump(ONE_LEAD, NO_UPDATE, writes));
    expect(plan.replay.map((o) => [o.name, o.table])).toEqual([['ledger_one_lead', 'ledger'], ['ledger_no_update', 'ledger']]);
    expect(plan.skipped).toEqual(['ledger_touch']);
    expect(plan.carried).toBe(3);
  });

  it('reads a dump written before objects were carried as not carrying them', () => {
    const [ledger, other] = dump();
    expect(assertReplayableDump([{ ...ledger!, objects: undefined }, other!])).toEqual({ replay: [], skipped: [], carried: null });
  });

  const refused: [string, ScopeDumpObject, RegExp][] = [
    ['a statement after a trigger body', trigger('t1', "CREATE TRIGGER t1 BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'no'); END; DROP TABLE other"), /does not end with the END/],
    ['a statement ridden inside a trigger body', trigger('t1', "CREATE TRIGGER t1 BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'no'); END; DROP TABLE other; END"), /more than one statement/],
    ['a statement after an index', index('i1', 'CREATE INDEX i1 ON ledger (who); DROP TABLE other'), /more than one statement/],
    ['an object on another table', index('i1', 'CREATE INDEX i1 ON other (id)'), /names another table/],
    ['an object on the spine', index('i1', 'CREATE INDEX i1 ON _substrat_tuples (subject)'), /names another table/],
    ['a name its own text does not give', index('i1', 'CREATE INDEX i2 ON ledger (who)'), /names another name/],
    ['a reserved name', index('_substrat_list_x', 'CREATE INDEX _substrat_list_x ON ledger (who)'), /reserved name/],
    ['a name a table has', index('other', 'CREATE INDEX other ON ledger (who)'), /already has/],
    ['a TEMP trigger', trigger('t1', "CREATE TEMP TRIGGER t1 BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'no'); END"), /shape a dump carries/],
    ['an INSTEAD OF trigger', trigger('t1', "CREATE TRIGGER t1 INSTEAD OF DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'no'); END"), /fires on no/],
    ['a trigger typed as an index', index('t1', "CREATE TRIGGER t1 BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'no'); END"), /shape a dump carries/],
  ];
  for (const [what, object, message] of refused) {
    it(`refuses ${what}`, () => {
      expect(() => assertReplayableDump(dump(object))).toThrow(message);
    });
  }

  it('refuses two objects of one name', () => {
    expect(() => assertReplayableDump(dump(ONE_LEAD, index('LEDGER_ONE_LEAD', 'CREATE INDEX LEDGER_ONE_LEAD ON ledger (id)')))).toThrow(/already has/);
  });
});
