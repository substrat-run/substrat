/**
 * What the kernel derived onto a module's tables, checked and put back (#2090).
 *
 * | Object | Is | When it is missing or not what the kernel emits |
 * |---|---|---|
 * | `_substrat_archived_at` / `_substrat_trashed_at` (#119) | state | fail closed: it cannot be invented again |
 * | the `born` / `moved` archive/trash guard triggers (#119) | derived | put back |
 * | the derived list indexes, partial per view on a stateful table (#811) | derived | put back |
 * | the search index and the three triggers keeping it in step (#827) | derived | rebuilt from the rows |
 *
 * The search triggers are a privacy fact, not only a freshness one: subject erasure rewrites a
 * row's text and relies on the update and delete triggers to take the old text out of the index.
 * Without them, erased text stays searchable.
 *
 * **An object is judged by its definition, not its name.** `sqlite_master` holds each one's
 * CREATE statement as it was run, and the kernel knows the statement it emits
 * (`DerivedObject`), so a same-named trigger that does nothing, an index on the wrong columns or
 * with the wrong partial predicate, and an object filed under another table are all "not
 * there". The text is compared exactly: nothing but the kernel writes these objects, and a
 * normalisation that forgave whitespace would forgive it inside a string literal too — a guard
 * keyed on a different entity type. An object an older kernel worded differently is re-created
 * once.
 *
 * Four places ask, and all four come here, so "what a table is owed" is written once:
 *
 * - **runtime DDL** (`ctx.sql`'s after-DDL hook, #1811) repairs inside the operation's
 *   transaction, whenever the scope has any derived plan. The text guard already refuses the DDL
 *   known to move a stateful table's rows; a search-only or list-only table has no such guard,
 *   and a module may rebuild it — this puts its triggers and indexes back before the operation
 *   commits. A lost state column fails the operation, and the DDL with it.
 * - **a migration** checks the state columns after its own SQL, inside its own transaction, so a
 *   migration that drops one rolls back with nothing applied. The last migration of a pass then
 *   repairs the derived objects, inside that same transaction: SQLite's ordinary
 *   create-copy-rename rebuild of a table drops its triggers and indexes with it, and the
 *   migrations that made them are journaled, so they never run again. Only after the last,
 *   because a rebuild split over two migrations copies its rows in the second, and a guard put
 *   back in between would refuse the archived ones — which also means such a split must ship
 *   in ONE deploy: split over two, the guard is back before the copy runs.
 * - **a wake with nothing pending** (and every `migrateScope`) repairs the same way, once per
 *   instance. That is what reaches a scope stripped before this existed, whose migrations are
 *   all journaled and will never run again.
 * - **a restore** repairs after the rows, inside the load's transaction, which may legitimately
 *   bring them archived or trashed.
 *
 * ## What the journal says a table is owed
 *
 * Every expectation comes from `_substrat_migrations`, not only from the declarations: a scope
 * mid-upgrade has declared a trash its column migration has not added yet, and a restored dump
 * carries the journal of the scope it came from. A column is owed once the migration that added
 * it is journaled; a derived object once the migration that derived it, for the CURRENT
 * declaration, is. An object from a withdrawn declaration is not this module's business.
 */
import { SubstratError } from '@substrat-run/contracts';
import type { DerivedObject } from './derived-object.js';
import {
  entityStateGuardVersion,
  entityStateTriggerDdl,
  entityStateTriggerObjects,
  stateColumnVersionsOf,
  type EntityStatePlan,
} from './entity-state.js';
import { listIndexDdl, listIndexObjects, listIndexVersion, type ListIndexPlan } from './list-index.js';
import type { ScopedSql } from './scope-host.js';
import { searchIndexDdl, searchIndexObjects, searchIndexVersion, type SearchIndexPlan } from './search-index.js';

/** A scope's derivation inputs: every registered module's plans, entity type → plan. */
export interface DerivedPlans {
  readonly state: ReadonlyMap<string, EntityStatePlan>;
  readonly lists: ReadonlyMap<string, ListIndexPlan>;
  readonly search: ReadonlyMap<string, SearchIndexPlan>;
}

/**
 * A table without a state column its journal says it has (`internal`). `migration` is the
 * journaled `<module>@<version>` that added the column — what a scope failing closed on a wake,
 * where no migration ran, records as its failure.
 */
export class StateColumnLost extends SubstratError {
  constructor(
    readonly migration: string,
    message: string,
  ) {
    super('internal', message);
  }
}

/** One derived set: its objects, and the drop-then-create DDL that makes all of them. */
interface Derived {
  readonly objects: readonly DerivedObject[];
  readonly ddl: string;
}

/** One table, as the journal says the kernel left it. */
interface TableExpectation {
  readonly table: string;
  /** The state columns its journal added, each with that migration's key — absent for none (yet). */
  readonly columns?: readonly { readonly column: string; readonly migration: string }[];
  readonly derived: Derived[];
}

interface CatalogueEntry {
  readonly type: string;
  readonly table: string;
  readonly sql: string | null;
}

/** `main`'s own catalogue by lowercased name — so a same-named temp object cannot stand in. */
function catalogueOf(sql: ScopedSql): Map<string, CatalogueEntry> {
  return new Map(
    sql
      .query<{ type: string; name: string; tbl_name: string; sql: string | null }>(
        `SELECT type, name, tbl_name, sql FROM main.sqlite_master`,
      )
      .map((r) => [r.name.toLowerCase(), { type: r.type, table: r.tbl_name, sql: r.sql }]),
  );
}

/** The first object of `d` the catalogue does not hold exactly as the kernel emits it. */
const wrongIn = (catalogue: Map<string, CatalogueEntry>, d: Derived): DerivedObject | undefined =>
  d.objects.find((o) => {
    const found = catalogue.get(o.name.toLowerCase());
    return (
      found?.type !== o.type ||
      found.table.toLowerCase() !== o.table.toLowerCase() ||
      found.sql !== o.sql
    );
  });

const columnsOn = (sql: ScopedSql, table: string): Set<string> =>
  new Set(sql.query<{ name: string }>(`SELECT name FROM pragma_table_info(?, 'main')`, [table]).map((r) => r.name.toLowerCase()));

function expectations(sql: ScopedSql, plans: DerivedPlans): TableExpectation[] {
  const journal = new Set(
    sql.query<{ module_id: string; version: string }>(`SELECT module_id, version FROM _substrat_migrations`).map(
      (r) => `${r.module_id}@${r.version}`,
    ),
  );
  const applied = (moduleId: string, version: string) => journal.has(`${moduleId}@${version}`);
  const byTable = new Map<string, { table: string; columns?: TableExpectation['columns']; derived: Derived[] }>();
  const entry = (table: string) => {
    const key = table.toLowerCase();
    if (!byTable.has(key)) byTable.set(key, { table, derived: [] });
    return byTable.get(key)!;
  };
  for (const plan of plans.state.values()) {
    const e = entry(plan.table);
    const columns = stateColumnVersionsOf(plan)
      .filter((c) => applied(plan.moduleId, c.version))
      .map((c) => ({ column: c.column, migration: `${plan.moduleId}@${c.version}` }));
    if (columns.length) e.columns = columns;
    if (applied(plan.moduleId, entityStateGuardVersion(plan))) {
      e.derived.push({ objects: entityStateTriggerObjects(plan), ddl: entityStateTriggerDdl(plan) });
    }
  }
  for (const plan of plans.lists.values()) {
    const objects = listIndexObjects(plan);
    if (objects.length && applied(plan.moduleId, listIndexVersion(plan))) {
      entry(plan.table).derived.push({ objects, ddl: listIndexDdl(plan) });
    }
  }
  // The DDL ends in a full `rebuild` from the content table, which is also what repairs an index
  // that went stale while its triggers were gone or wrong.
  for (const plan of plans.search.values()) {
    if (applied(plan.moduleId, searchIndexVersion(plan))) {
      entry(plan.table).derived.push({ objects: searchIndexObjects(plan), ddl: searchIndexDdl(plan) });
    }
  }
  return [...byTable.values()];
}

const lost = (after: string, table: TableExpectation, what: string, migration: string): never => {
  throw new StateColumnLost(
    migration,
    `${after} left '${table.table}' without ${what} — its archive/trash guarantees depend on it; nothing was changed`,
  );
};

/**
 * The state half: the table holds every column its journal added. Throws `StateColumnLost` on
 * the first one gone. An absent table counts as losing them all, unless `absentTable` is
 * `'skip'` — a restore's case, where a dump that did not carry a table is not made to invent one.
 */
function assertColumns(
  sql: ScopedSql,
  catalogue: Map<string, CatalogueEntry>,
  table: TableExpectation,
  after: string,
  absentTable: 'fail' | 'skip' = 'fail',
): void {
  if (!table.columns) return;
  if (catalogue.get(table.table.toLowerCase())?.type !== 'table') {
    if (absentTable === 'skip') return;
    lost(after, table, 'its table', table.columns[0]!.migration);
  }
  const present = columnsOn(sql, table.table);
  for (const c of table.columns) if (!present.has(c.column)) lost(after, table, c.column, c.migration);
}

/**
 * After runtime DDL, inside the operation's transaction: the same repair a migration pass makes.
 * A lost state column throws `internal`, and the operation and its DDL roll back.
 */
export function afterRuntimeDdl(sql: ScopedSql, run: (ddl: string) => void, plans: DerivedPlans): void {
  repairDerivedObjects(sql, run, plans, { after: 'runtime DDL' });
}

/** Whether a scope has anything derived for `afterRuntimeDdl` to keep — the hook is installed only then. */
export const derivesAnything = (plans: DerivedPlans): boolean =>
  plans.state.size > 0 || plans.lists.size > 0 || plans.search.size > 0;

/**
 * A migration's half, after its own SQL and inside its own transaction: the state columns are
 * still where the journal put them. A migration that dropped one throws here and rolls back —
 * the rows keep their state, and the scope fails closed naming the migration.
 */
export function assertEntityStateColumns(sql: ScopedSql, plans: DerivedPlans, after: string): void {
  if (plans.state.size === 0) return; // most scopes: nothing holds state, so no read at all
  const catalogue = catalogueOf(sql);
  for (const table of expectations(sql, plans)) assertColumns(sql, catalogue, table, after);
}

/**
 * Check the state columns, then re-create every derived set the journal says a table is owed
 * and the catalogue does not hold exactly as emitted. Run inside the caller's transaction, so a
 * failure — a lost column, or DDL that will not apply — rolls the caller back whole.
 *
 * `run` executes a multi-statement script (a Durable Object splits it first). `after` names what
 * left the schema this way, for the message. `absentTable: 'skip'` is a restore's: a table the
 * dump did not carry is left absent, and owed nothing. Everywhere else an owed table that is
 * gone has lost its state, and fails closed.
 */
export function repairDerivedObjects(
  sql: ScopedSql,
  run: (ddl: string) => void,
  plans: DerivedPlans,
  opts: { readonly after: string; readonly absentTable?: 'fail' | 'skip' },
): void {
  const catalogue = catalogueOf(sql);
  for (const table of expectations(sql, plans)) {
    assertColumns(sql, catalogue, table, opts.after, opts.absentTable);
    if (catalogue.get(table.table.toLowerCase())?.type !== 'table') continue;
    for (const d of table.derived) if (wrongIn(catalogue, d)) run(d.ddl);
  }
}

/**
 * Both adapters' migration pass, after one migration's SQL and inside its transaction: the
 * column check, and — after the last migration of the pass — the derived objects repaired.
 * `key` is `<module>@<version>`, which a failure names. A last entry the pass skips (journaled
 * by a pass that ran first) needs nothing here: that pass repaired them after it.
 */
export function afterMigration(
  sql: ScopedSql,
  run: (ddl: string) => void,
  plans: DerivedPlans,
  key: string,
  last: boolean,
): void {
  if (last) repairDerivedObjects(sql, run, plans, { after: `migration ${key}` });
  else assertEntityStateColumns(sql, plans, `migration ${key}`);
}
