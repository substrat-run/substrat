import { describe, expect, it } from 'vitest';
import { assertReplayableDump, referencedTables } from '../src/index.js';

/**
 * #1898: a replayed table's DDL may not name a `_substrat_*` table in a `REFERENCES` clause.
 * A restore replays a vertical table's `CREATE TABLE` verbatim, so one that declared the spine
 * as its parent made the kernel's own writes to that table fail on the vertical's rows.
 */
const table = (name: string, ddl: string) => ({ name, ddl, columns: ['t'] });

describe('assertReplayableDump: a foreign key to the spine', () => {
  const refused = [
    'CREATE TABLE notes (t TEXT REFERENCES _substrat_tuples(subject))',
    'CREATE TABLE notes (t TEXT, FOREIGN KEY (t) REFERENCES _substrat_outbox (id))',
    // Case-folded, as SQLite resolves a table name.
    'CREATE TABLE notes (t TEXT REFERENCES _Substrat_Tuples(subject))',
    'CREATE TABLE notes (t TEXT REFERENCES _SUBSTRAT_TENANT_TUPLES(subject))',
    // Every quoting style SQLite accepts in that position.
    'CREATE TABLE notes (t TEXT REFERENCES "_substrat_tuples"(subject))',
    'CREATE TABLE notes (t TEXT REFERENCES `_substrat_tuples`(subject))',
    'CREATE TABLE notes (t TEXT REFERENCES [_substrat_tuples](subject))',
    "CREATE TABLE notes (t TEXT REFERENCES '_substrat_tuples'(subject))",
    // A comment is whitespace to SQLite, so it is no hiding place.
    'CREATE TABLE notes (t TEXT REFERENCES/**/_substrat_tuples(subject))',
    'CREATE TABLE notes (t TEXT REFERENCES -- parent\n _substrat_tuples(subject))',
    // The prefix is the spine guard's, `_substrat`, with no trailing underscore.
    'CREATE TABLE notes (t TEXT REFERENCES _substratx(subject))',
    // One of several.
    'CREATE TABLE notes (a TEXT REFERENCES lists(id), t TEXT REFERENCES _substrat_tuples(subject))',
  ];
  for (const ddl of refused) {
    it(`refuses ${JSON.stringify(ddl)}`, () => {
      expect(() => assertReplayableDump([table('notes', ddl)])).toThrow(/foreign key to the platform spine/);
    });
  }

  it('names the table and every spine target in the refusal', () => {
    const ddl = 'CREATE TABLE notes (a TEXT REFERENCES _substrat_tuples(subject), b TEXT REFERENCES "_substrat_outbox"(id))';
    expect(() => assertReplayableDump([table('notes', ddl)])).toThrow(/"notes".*_substrat_tuples, _substrat_outbox/);
  });

  // The twins: nothing here refuses a foreign key as such.
  const accepted = [
    'CREATE TABLE notes (t TEXT REFERENCES lists(id))',
    'CREATE TABLE notes (t TEXT, FOREIGN KEY (t) REFERENCES "lists" (id))',
    // A table whose own name merely contains the prefix further in is not spine.
    'CREATE TABLE notes (t TEXT REFERENCES my_substrat_tuples(id))',
    // Inside a string literal or a comment, `REFERENCES _substrat_…` is not a clause.
    "CREATE TABLE notes (t TEXT DEFAULT 'REFERENCES _substrat_tuples(subject)')",
    'CREATE TABLE notes (t TEXT /* REFERENCES _substrat_tuples(subject) */)',
    // A column called "references" is not the keyword.
    'CREATE TABLE notes (t TEXT, "references" _substrat_x)',
  ];
  for (const ddl of accepted) {
    it(`accepts ${JSON.stringify(ddl)}`, () => {
      expect(() => assertReplayableDump([table('notes', ddl)])).not.toThrow();
    });
  }

  it("does not judge a spine table's own DDL, which a loader never replays", () => {
    // The kernel's own spine may reference itself; a restore builds it from its own DDL.
    const ddl = 'CREATE TABLE _substrat_connection_grants (t TEXT REFERENCES _substrat_connections(id))';
    expect(() => assertReplayableDump([table('_substrat_connection_grants', ddl)])).not.toThrow();
  });
});

describe('referencedTables: the one reading of REFERENCES', () => {
  it('reads the target past a comment, which a regex expecting whitespace did not', () => {
    expect(referencedTables('CREATE TABLE a (v TEXT REFERENCES/* x */crm_vendors(id))')).toEqual(['crm_vendors']);
  });

  it('skips a REFERENCES inside a string literal', () => {
    expect(referencedTables("CREATE TABLE a (v TEXT DEFAULT 'REFERENCES b(id)')")).toEqual([]);
  });
});
