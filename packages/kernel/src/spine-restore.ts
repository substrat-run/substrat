import { substratError } from '@substrat-run/contracts';
import { SCHEDULE_STATE_KIND_OF_OP } from './platform-sweep.js';
import { isSearchIndexTable } from './search-index.js';

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
 * - a column the kernel's table does not have is refused, since there is nowhere to put it;
 * - a column the dump lacks takes the kernel's default (NULL for every additive column), so
 *   a dump taken before a column existed still restores. The one column that is not additive,
 *   `_substrat_schedule_state.kind` (#1288, part of the key), is derived from the row the way
 *   the #1288 rebuild derives it;
 * - a spine table the kernel does not build is refused (`assertSpineTablesBuilt`), every such
 *   table named at once.
 *
 * Tables outside the spine keep the dump's own DDL: a vertical's schema is the dump's to say.
 */

/** A kernel-owned table, which a restore builds from the kernel's DDL rather than the dump's. */
export function isSpineTable(name: string): boolean {
  // The search index is `_substrat_`-prefixed too, but derived: a loader rebuilds it, never loads it.
  return name.startsWith('_substrat_') && !isSearchIndexTable(name);
}

/**
 * Refuse a dump carrying `_substrat_*` tables this host's kernel does not build, naming every
 * one of them. Called before any spine row goes in, inside the load's transaction; `built`
 * answers whether the kernel built a table of that name.
 *
 * The usual cause is a dump from the other kind of host: a Durable Object's scope builds spine
 * tables (`_substrat_roles`, `_substrat_tenant_tuples`, …) that a node scope keeps in its
 * directory instead. Loading one anyway would mean dropping its rows, which a restore does not
 * do silently.
 */
export function assertSpineTablesBuilt(names: readonly string[], built: (name: string) => boolean): void {
  const missing = names.filter((n) => isSpineTable(n) && !built(n));
  if (missing.length > 0) throw unbuiltSpineTables(missing);
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
 * The `INSERT` that loads one dumped spine table's rows into the table the kernel built, one
 * row of positional parameters per execution, in the dump's column order.
 *
 * `kernelColumns` is the kernel table's column list as the loader reads it back, or
 * `undefined` when the kernel built no such table; both refusals throw `validation_failed`
 * inside the load's transaction, so the target keeps what it held. The names are quoted as
 * given: the loader has already passed the dump through `assertReplayableDump`.
 */
export function spineRowsInsert(
  table: { name: string; columns: readonly string[] },
  kernelColumns: readonly string[] | undefined,
): string {
  // `assertSpineTablesBuilt` has refused this already, naming every such table; kept as the backstop.
  if (kernelColumns === undefined) throw unbuiltSpineTables([table.name]);
  const known = new Set(kernelColumns);
  const unknown = table.columns.filter((c) => !known.has(c));
  if (unknown.length > 0) {
    throw substratError(
      'validation_failed',
      `restore refused: the dump's ${table.name} has column(s) this host's kernel does not know: ` +
        `${unknown.join(', ')}. Nothing was changed.`,
    );
  }
  const quoted = table.columns.map((c) => `"${c}"`);
  const derived = Object.entries(DERIVED_COLUMNS[table.name] ?? {}).filter(
    ([c]) => known.has(c) && !table.columns.includes(c),
  );
  if (derived.length === 0) {
    return `INSERT INTO "${table.name}" (${quoted.join(', ')}) VALUES (${quoted.map(() => '?').join(', ')})`;
  }
  // The derivation reads the dumped row by name, so the row is a one-row SELECT to read from.
  const row = table.columns.map((c, i) => `? AS ${quoted[i]}`).join(', ');
  return (
    `INSERT INTO "${table.name}" (${[...quoted, ...derived.map(([c]) => `"${c}"`)].join(', ')}) ` +
    `SELECT ${[...quoted, ...derived.map(([, expr]) => expr)].join(', ')} FROM (SELECT ${row})`
  );
}
