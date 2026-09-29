import { SPINE_PREFIX, namesSpineTable, substratError } from '@substrat-run/contracts';
import { SCHEDULE_STATE_KIND_OF_OP } from './platform-sweep.js';
import { isSearchIndexTable } from './search-index.js';
import { SYSTEM_SWITCHES_BACKFILL_SQL, dumpCarriesSystemSwitches } from './system-switch-record.js';

/**
 * How a restore, fork or carry loads a dump's `_substrat_*` spine tables (#1883). One
 * definition for both adapters' loaders, so the DO and the pure host build the same tables
 * from the same dump.
 *
 * A dump used to be replayed table by table, `CREATE TABLE` from the dump and then its rows,
 * spine included; the kernel's `CREATE TABLE IF NOT EXISTS` afterwards filled only the gaps.
 * So a dump could decide the schema of the tables the permission checker reads. A dump that
 * declared `_substrat_tuples.object` as `COLLATE NOCASE` made every `=` the checker and the
 * spine SQL wrote on it ignore case: a grant on `aiTurn:x` answered for `aiturn:x`.
 *
 * Now the loader builds every spine table from its own kernel DDL, and the dump contributes
 * rows only, inserted by column name:
 * - a column the kernel's table does not have (a dump from a newer kernel) is added as a plain
 *   untyped column, unless it is named for SQLite's rowid (refused, since it would shadow it), with no type, collation, constraint or default, and keeps its values
 *   (`spineColumnAdditions`). It is not one the checker reads, and it carries nothing that
 *   could change how the columns the checker does read compare. When a later kernel adds the
 *   column for real, its additive ALTER meets it and tolerates it as a duplicate;
 * - a column the dump lacks takes the kernel's default (NULL for every additive column), so
 *   a dump taken before a column existed still restores. The one column that is not additive,
 *   `_substrat_schedule_state.kind` (#1288, part of the key), is derived from the row the way
 *   the #1288 rebuild derives it;
 * - a spine table the kernel does not build is refused (`assertSpineTablesBuilt`), every such
 *   table named at once.
 *
 * In a scope, tables outside the spine keep the dump's own DDL: a vertical's schema is the
 * dump's to say. A directory has no vertical tables, so there every table is built by the
 * host and loaded by these same rules, and a table it does not build is refused
 * (`assertDirectoryTablesBuilt`, #1912).
 */

/**
 * A kernel-owned table, which a restore builds from the kernel's DDL rather than the dump's.
 * The prefix is the spine guard's, compared the way SQLite compares table names, without case:
 * a dump's `_Substrat_tuples` IS the tuples table, and read as a vertical one its DDL would be
 * replayed and the kernel's `IF NOT EXISTS` would skip its own.
 */
export function isSpineTable(name: string): boolean {
  const lower = name.toLowerCase();
  // The search index is spine-prefixed too, but derived: a loader rebuilds it, never loads it.
  return lower.startsWith(SPINE_PREFIX) && !isSearchIndexTable(lower);
}

/**
 * Refuse a dump carrying `_substrat_*` tables this host's kernel does not build, naming every
 * one of them. Called before any spine row goes in, inside the load's transaction; `columnsOf`
 * is the same lookup `dumpRowsInsert` takes, `undefined` for a table the kernel did not build.
 *
 * The usual cause is a dump from the other kind of host: a Durable Object's scope builds spine
 * tables (`_substrat_roles`, `_substrat_tenant_tuples`, …) that a node scope keeps in its
 * directory instead. Loading one anyway would mean dropping its rows, which a restore does not
 * do silently.
 *
 * Every `_substrat*` name is judged, the search index's namespace included (`namesSpineTable`,
 * not `isSpineTable`): a scope restore has skipped its index tables before this, since it
 * rebuilds them. A directory restore judges every table instead (`assertDirectoryTablesBuilt`).
 */
export function assertSpineTablesBuilt(names: readonly string[], columnsOf: KernelColumnsOf): void {
  const missing = names.filter((n) => namesSpineTable(n) && columnsOf(n) === undefined);
  if (missing.length > 0) throw unbuiltSpineTables(missing);
}

/** A table's columns as the kernel built it here, or `undefined` when it built no such table. */
export type KernelColumnsOf = (name: string) => readonly string[] | undefined;

/**
 * Refuse a directory dump carrying any table the directory does not build, spine or not, naming
 * every one of them (#1912). A directory holds only the platform's own tables, so there is no
 * vertical table whose DDL the dump could have a say in: an extra table would keep the dump's
 * DDL, and with it whatever that declares, such as a `REFERENCES tenants` that fails the
 * delete of a referenced row. `loadDirectoryDump` calls it first, where `assertSpineTablesBuilt`
 * is in a scope restore, with the same `columnsOf`.
 */
export function assertDirectoryTablesBuilt(names: readonly string[], columnsOf: KernelColumnsOf): void {
  const missing = names.filter((n) => columnsOf(n) === undefined);
  if (missing.length > 0) {
    throw substratError(
      'validation_failed',
      `restore refused: the dump carries table(s) this directory does not build: ${missing.join(', ')}. ` +
        'A directory holds only the platform\'s own tables, each built by this code, and a table it does not ' +
        'build would keep the dump\'s own schema. Nothing was changed.',
    );
  }
}

const unbuiltSpineTables = (names: readonly string[]) =>
  substratError(
    'validation_failed',
    `restore refused: the dump carries spine table(s) this host's kernel does not build: ${names.join(', ')}. ` +
      'It was exported by a different kind of host (a Durable Object scope holds spine tables a node scope ' +
      'keeps in its directory) or by a newer kernel, and its rows would have nowhere to go. Nothing was changed.',
  );

/**
 * Columns the kernel's table requires that a dump taken before them lacks, with the
 * expression that derives each from the dumped row. Every other spine column is additive
 * and defaults, so it needs no entry.
 */
const DERIVED_COLUMNS: Record<string, Record<string, string>> = {
  _substrat_schedule_state: { kind: SCHEDULE_STATE_KIND_OF_OP },
};

/**
 * The `INSERT` that loads one dumped table's rows, one row of positional parameters per
 * execution, in the dump's column order: `spineRowsInsert` for a spine table, and the dump's
 * own columns for a vertical one. A directory builds every table, so it calls
 * `spineRowsInsert` directly. The names are quoted as given: the loader has already passed
 * the dump through `assertReplayableDump`.
 */
export function dumpRowsInsert(table: { name: string; columns: readonly string[] }, columnsOf: KernelColumnsOf): string {
  return isSpineTable(table.name) ? spineRowsInsert(table, columnsOf(table.name)) : plainInsert(table);
}

const plainInsert = (table: { name: string; columns: readonly string[] }): string =>
  `INSERT INTO "${table.name}" (${table.columns.map((c) => `"${c}"`).join(', ')}) ` +
  `VALUES (${table.columns.map(() => '?').join(', ')})`;

/** Column names as SQLite resolves them, without case. */
const lowered = (columns: readonly string[]) => new Set(columns.map((c) => c.toLowerCase()));

/**
 * The statements that add to a table the host built (a spine table, or any directory table,
 * #1912) each column the dump carries and the host's table does not, as a plain untyped column:
 * `ADD COLUMN "<name>"`, lowercased, and nothing after it, so it has no type, collation,
 * constraint or default. Run after `assertSpineTablesBuilt` / `assertDirectoryTablesBuilt` and
 * before the table's rows go in, inside the load's transaction. The names are the dump's, which
 * `assertReplayableDump` has already held to the identifier rule. Empty for a table the host
 * did not build, which those have refused.
 */
export function spineColumnAdditions(
  table: { name: string; columns: readonly string[] },
  kernelColumns: readonly string[] | undefined,
): string[] {
  if (kernelColumns === undefined) return [];
  const known = lowered(kernelColumns);
  const unknown = table.columns.filter((c) => !known.has(c.toLowerCase()));
  // A real column named for the rowid shadows SQLite's alias. On the outbox, `rowid` is the mark
  // the #1705 and #1746 since-queries read (`OUTBOX_MARK_SQL`), so a dump's value would silence
  // them from then on, and survive every later export. A directory table is held to the same
  // rule: whatever reads its rowid, now or later, reads the dump's value instead.
  const aliased = unknown.filter((c) => ROWID_ALIASES.has(c.toLowerCase()));
  if (aliased.length > 0) {
    throw substratError(
      'validation_failed',
      `restore refused: the dump's ${table.name} has column(s) named for SQLite's rowid: ${aliased.join(', ')}. ` +
        'A real column by that name would shadow the rowid the kernel reads. Nothing was changed.',
    );
  }
  // Lowercased, as every kernel column is spelled: a later kernel adding the column for real
  // then meets the name it expects, whatever case the dump used.
  return unknown.map((c) => `ALTER TABLE "${table.name}" ADD COLUMN "${c.toLowerCase()}"`);
}

/** The names SQLite resolves to a table's rowid, unless a real column takes one. */
const ROWID_ALIASES: ReadonlySet<string> = new Set(['rowid', 'oid', '_rowid_']);

/**
 * The `INSERT` that loads one dumped table's rows into the table the host built: a spine table,
 * or any directory table (#1912).
 *
 * `kernelColumns` is the built table's column list as the loader reads it back after
 * `spineColumnAdditions`, or `undefined` when the host built no such table. Either refusal
 * below is a backstop the loader's order makes unreachable, and throws `validation_failed`
 * inside the load's transaction, so the target keeps what it held.
 */
export function spineRowsInsert(
  table: { name: string; columns: readonly string[] },
  kernelColumns: readonly string[] | undefined,
): string {
  // `assertSpineTablesBuilt` / `assertDirectoryTablesBuilt` has refused this already, naming every such table.
  if (kernelColumns === undefined) throw unbuiltSpineTables([table.name]);
  const known = lowered(kernelColumns);
  // `spineColumnAdditions` has added every such column already.
  const unknown = table.columns.filter((c) => !known.has(c.toLowerCase()));
  if (unknown.length > 0) {
    throw substratError(
      'validation_failed',
      `restore refused: the dump's ${table.name} has column(s) that were not added to this host's table: ` +
        `${unknown.join(', ')}. Nothing was changed.`,
    );
  }
  const dumped = lowered(table.columns);
  const derived = Object.entries(DERIVED_COLUMNS[table.name.toLowerCase()] ?? {}).filter(
    ([c]) => known.has(c) && !dumped.has(c),
  );
  if (derived.length === 0) return plainInsert(table);
  const quoted = table.columns.map((c) => `"${c}"`);
  // The derivation reads the dumped row by name, so the row is a one-row SELECT to read from.
  const row = table.columns.map((c, i) => `? AS ${quoted[i]}`).join(', ');
  return (
    `INSERT INTO "${table.name}" (${[...quoted, ...derived.map(([c]) => `"${c}"`)].join(', ')}) ` +
    `SELECT ${[...quoted, ...derived.map(([, expr]) => expr)].join(', ')} FROM (SELECT ${row})`
  );
}

/**
 * The naming columns a scope row from before the directory left NULL, filled with the defaults
 * `resolveScopeRecord` applies: a ULID lowercases into a valid slug, so the placeholder is unique
 * by construction. Run by both adapters' schema pass on every start, and by a directory restore
 * after its rows are in, inside its transaction (#1912). One statement per entry, since a
 * Durable Object's `exec` and better-sqlite3's `prepare` each take one.
 */
export const LEGACY_SCOPE_ROWS_BACKFILL: readonly string[] = [
  'UPDATE scopes SET slug = lower(scope_id) WHERE slug IS NULL',
  "UPDATE scopes SET kind = 'scope' WHERE kind IS NULL",
  'UPDATE scopes SET name = slug WHERE name IS NULL',
];

/**
 * Load a directory dump's rows into the tables the host has just built from its own schema
 * (#1912): the one sequence both adapters' directory restores run, inside their transaction,
 * after dropping the old directory and running the schema pass.
 *
 * 1. refuse a table the directory does not build (`assertDirectoryTablesBuilt`);
 * 2. add each column the dump carries and this code does not know, bare and lowercased, and
 *    refuse one named for the rowid (`spineColumnAdditions`);
 * 3. insert every row by column name, against the columns read back after step 2
 *    (`spineRowsInsert`);
 * 4. fill a pre-directory scope row's naming columns (`LEGACY_SCOPE_ROWS_BACKFILL`);
 * 5. backfill the schedule switch's record from the dump's own admin log, when the dump
 *    predates it (#1674). One that carried it keeps its rows and is never backfilled over.
 *
 * A throw anywhere is the caller's transaction rolling back, so the directory keeps what it held.
 */
export function loadDirectoryDump(
  tables: readonly { name: string; columns: readonly string[]; rows: readonly (readonly unknown[])[] }[],
  host: {
    columnsOf: KernelColumnsOf;
    exec: (sql: string) => void;
    insert: (sql: string, rows: readonly (readonly unknown[])[]) => void;
  },
): void {
  assertDirectoryTablesBuilt(tables.map((t) => t.name), host.columnsOf);
  for (const t of tables) for (const alter of spineColumnAdditions(t, host.columnsOf(t.name))) host.exec(alter);
  for (const t of tables) {
    if (t.rows.length > 0) host.insert(spineRowsInsert(t, host.columnsOf(t.name)), t.rows);
  }
  for (const stmt of LEGACY_SCOPE_ROWS_BACKFILL) host.exec(stmt);
  if (!dumpCarriesSystemSwitches(tables.map((t) => t.name))) host.exec(SYSTEM_SWITCHES_BACKFILL_SQL);
}
