/**
 * Reading a migration journal — the verification half of `emitTables`.
 *
 * The emitter's claim is "what this emits is what the database ends up with";
 * this is how that gets checked. They live together because they are two halves
 * of one statement, and a reader that drifts from its emitter checks nothing.
 *
 * All three readers are now views onto one replay (`./replay.ts`): the journal
 * is run into an in-memory SQLite and the schema read back through `PRAGMA`.
 * Before that they were three hand-rolled parsers over SQL text, and #807 is
 * what that cost — the same table reformatted read as a different schema, and
 * the three `RENAME TO` / `RENAME COLUMN` / `DROP TABLE` replay loops that used
 * to live here, one per reader, were each a re-implementation of what the
 * database does for free.
 */
import { readSchema } from './replay.js';

/**
 * Column names per table, read out of a migration journal's SQL.
 *
 * Three engines had hand-rolled a copy of this and the copies had already
 * drifted — none followed `RENAME TO`, so a journal that rebuilds a table under
 * a temporary name would report the pre-rebuild columns forever.
 *
 * It exists because a registry and a journal are two descriptions of one schema
 * until migrations are derived from the registry. Holding them to each other is
 * what keeps that duplication safe in the meantime.
 *
 * Everything a real journal does is handled, because SQLite handles it:
 * `ADD COLUMN`, `DROP TABLE`, `RENAME COLUMN`, and the `RENAME TO` that an
 * append-only journal uses to rebuild a table by creating a `_new`, copying,
 * dropping the original and renaming onto its name.
 */
export function journalColumns(sql: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [table, schema] of readSchema(sql)) out.set(table, new Set(schema.columns));
  return out;
}

/**
 * UNIQUE constraints per table, read out of a journal.
 *
 * `journalColumns` answers "which columns exist". But a declared `key` is a
 * schema fact too, and adding one to an entity that already has a table is a
 * change SQLite cannot make in place. Without this the planner reported "up to
 * date" over a missing constraint.
 *
 * All three spellings count, because the database does not distinguish them:
 * table-level `UNIQUE (a, b)`, column-level `b TEXT UNIQUE`, and
 * `CREATE UNIQUE INDEX … ON t (b)`. A PARTIAL index (`… WHERE deleted_at IS
 * NULL`) is excluded — it constrains a subset of the rows, so counting it would
 * claim a guarantee the database does not make.
 *
 * Normalised to `a, b` (single space, key order preserved) so the same
 * constraint written two ways compares equal.
 */
export function journalUniques(sql: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [table, schema] of readSchema(sql)) out.set(table, new Set(schema.uniques));
  return out;
}

/**
 * The primary key per table, read out of a journal.
 *
 * `journalColumns` answers "which columns exist" and `journalUniques` "which
 * uniqueness rules"; neither says which columns *identify* a row, and that gap
 * is what made #804 invisible. A production vertical's parity check compared
 * names, types and nullability across 63 tables and reported 63/63 while 15 of
 * the emitted tables had no primary key at all.
 *
 * A table with no primary key maps to an EMPTY array rather than being absent —
 * "the journal never built this table" and "the journal built it without a key"
 * are different answers, and only one of them is a bug.
 *
 * Order is the KEY's order, which is not always declaration order: a composite
 * primary key is the index its columns are searched by, so `(a, b)` and `(b, a)`
 * are not the same key.
 */
export function journalPrimaryKeys(sql: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [table, schema] of readSchema(sql)) out.set(table, [...schema.primaryKey]);
  return out;
}
