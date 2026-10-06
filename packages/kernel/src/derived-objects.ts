/**
 * What the kernel derived onto a module's tables, checked and put back (#2090).
 *
 * | Object | Is | After it goes missing |
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
 * Three places ask, and all three come here, so "which objects a table is owed" is written once:
 *
 * - **runtime DDL** (`ctx.sql`'s after-DDL hook) checks every stateful table, and the operation
 *   rolls back. A module's runtime DDL is not reviewed, so a schema the kernel did not expect is
 *   refused, not repaired.
 * - **a migration** checks the state columns after its own SQL, inside its own transaction, so a
 *   migration that drops one rolls back with nothing applied. The last migration of a pass then
 *   puts the derived objects back, inside that same transaction: SQLite's ordinary
 *   create-copy-rename rebuild of a table drops its triggers and indexes with it, and the
 *   migrations that made them are journaled, so they never run again.
 * - **a restore** puts them back after the rows, which may legitimately arrive archived or
 *   trashed.
 *
 * ## What the journal says a table is owed
 *
 * Every expectation comes from `_substrat_migrations`, not only from the declarations: a scope
 * mid-upgrade has declared a trash its column migration has not added yet, and a restored dump
 * carries the journal of the scope it came from. A column is owed once the migration that added
 * it is journaled; a derived object once the migration that derived it, for the CURRENT
 * declaration, is. An object from a withdrawn declaration is not this module's business.
 */
import { substratError } from '@substrat-run/contracts';
import {
  ENTITY_STATE_TRIGGER_PREFIX,
  entityStateGuardVersion,
  entityStateTriggerDdl,
  stateColumnVersionsOf,
  type EntityStatePlan,
} from './entity-state.js';
import { listIndexColumns, listIndexDdl, listIndexVersion, type ListIndexPlan } from './list-index.js';
import type { ScopedSql } from './scope-host.js';
import { searchIndexDdl, searchIndexObjects, searchIndexVersion, type SearchIndexPlan } from './search-index.js';

/** A scope's derivation inputs: every registered module's plans, entity type → plan, as the adapter keeps them. */
export interface DerivedPlans {
  readonly state: ReadonlyMap<string, EntityStatePlan>;
  readonly lists: ReadonlyMap<string, ListIndexPlan>;
  readonly search: ReadonlyMap<string, SearchIndexPlan>;
}

/** One derived set: the objects it creates, and the drop-then-create DDL that creates them. */
interface Derived {
  readonly objects: readonly { readonly name: string; readonly type: string }[];
  readonly ddl: string;
  /** Run whenever the table is owed it, not only when something is missing — cheap, and it replaces an impostor. */
  readonly always?: boolean;
}

/** One table, as the journal says the kernel left it. */
interface TableExpectation {
  readonly table: string;
  /** The state columns its journal added — absent for a table that holds none (yet). */
  readonly columns?: readonly string[];
  readonly derived: Derived[];
}

/** `main`'s own catalogue, lowercased — so a same-named temp object cannot stand in. */
function catalogueOf(sql: ScopedSql): Map<string, string> {
  return new Map(
    sql.query<{ type: string; name: string }>(`SELECT type, name FROM main.sqlite_master`).map((r) => [r.name.toLowerCase(), r.type]),
  );
}

const columnsOn = (sql: ScopedSql, table: string): Set<string> =>
  new Set(sql.query<{ name: string }>(`SELECT name FROM pragma_table_info(?, 'main')`, [table]).map((r) => r.name.toLowerCase()));

const missingFrom = (catalogue: Map<string, string>, d: Derived) =>
  d.objects.find((o) => catalogue.get(o.name.toLowerCase()) !== o.type);

function expectations(sql: ScopedSql, plans: DerivedPlans): TableExpectation[] {
  const journal = new Set(
    sql.query<{ module_id: string; version: string }>(`SELECT module_id, version FROM _substrat_migrations`).map(
      (r) => `${r.module_id}@${r.version}`,
    ),
  );
  const applied = (moduleId: string, version: string) => journal.has(`${moduleId}@${version}`);
  const byTable = new Map<string, { table: string; columns?: string[]; derived: Derived[] }>();
  const entry = (table: string) => {
    const key = table.toLowerCase();
    if (!byTable.has(key)) byTable.set(key, { table, derived: [] });
    return byTable.get(key)!;
  };
  for (const plan of plans.state.values()) {
    const e = entry(plan.table);
    const columns = stateColumnVersionsOf(plan)
      .filter((c) => applied(plan.moduleId, c.version))
      .map((c) => c.column);
    if (columns.length) e.columns = columns;
    if (applied(plan.moduleId, entityStateGuardVersion(plan))) {
      e.derived.push({
        objects: ['born', 'moved'].map((s) => ({ name: `${ENTITY_STATE_TRIGGER_PREFIX}${plan.table}_${s}`, type: 'trigger' })),
        ddl: entityStateTriggerDdl(plan),
        always: true,
      });
    }
  }
  for (const plan of plans.lists.values()) {
    if (!applied(plan.moduleId, listIndexVersion(plan))) continue;
    const objects = listIndexColumns(plan).map((i) => ({ name: i.name, type: 'index' }));
    if (objects.length) entry(plan.table).derived.push({ objects, ddl: listIndexDdl(plan) });
  }
  // Only when something is missing: the DDL ends in a full `rebuild` from the content table,
  // which is also what repairs an index that went stale while its triggers were gone.
  for (const plan of plans.search.values()) {
    if (applied(plan.moduleId, searchIndexVersion(plan))) {
      entry(plan.table).derived.push({ objects: searchIndexObjects(plan), ddl: searchIndexDdl(plan) });
    }
  }
  return [...byTable.values()];
}

/** The state half: the table exists and holds every column its journal added. */
function assertColumns(sql: ScopedSql, catalogue: Map<string, string>, table: TableExpectation, after: string): void {
  if (!table.columns) return;
  const fail = (what: string): never => {
    throw substratError(
      'internal',
      `${after} left '${table.table}' without ${what} — its archive/trash guarantees depend on it; nothing was changed`,
    );
  };
  if (catalogue.get(table.table.toLowerCase()) !== 'table') fail('its table');
  const present = columnsOn(sql, table.table);
  for (const column of table.columns) if (!present.has(column)) fail(column);
}

/**
 * After runtime DDL: every stateful table still carries its columns and everything derived onto
 * it. Throws `internal` naming the table and what it lost; the operation and its DDL roll back.
 */
export function assertEntityStateIntact(sql: ScopedSql, plans: DerivedPlans): void {
  const after = 'runtime DDL';
  const catalogue = catalogueOf(sql);
  for (const table of expectations(sql, plans)) {
    if (!table.columns) continue;
    assertColumns(sql, catalogue, table, after);
    for (const d of table.derived) {
      const missing = missingFrom(catalogue, d);
      if (missing) {
        throw substratError(
          'internal',
          `${after} left '${table.table}' without its ${missing.type} ${missing.name} — its archive/trash guarantees depend on it; nothing was changed`,
        );
      }
    }
  }
}

/**
 * A migration's half, after its own SQL and inside its own transaction: the state columns are
 * still where the journal put them. A migration that dropped one throws here and rolls back —
 * the rows keep their state, and the scope fails closed naming the migration.
 */
export function assertEntityStateColumns(sql: ScopedSql, plans: DerivedPlans, after: string): void {
  const catalogue = catalogueOf(sql);
  for (const table of expectations(sql, plans)) assertColumns(sql, catalogue, table, after);
}

/**
 * Put back every derived object the journal says a table is owed and the catalogue lacks.
 *
 * `run` executes a multi-statement script (a Durable Object splits it first). A table that is
 * absent, or is missing a state column, is left alone: there is nothing to derive onto, and
 * `assertEntityStateColumns` is what says so where it matters. The archive/trash triggers are
 * re-created whenever owed; a list or search index only when one of its objects is missing,
 * since rebuilding an index over a large table on every pass is not cheap.
 */
export function rederiveObjects(sql: ScopedSql, run: (ddl: string) => void, plans: DerivedPlans): void {
  const catalogue = catalogueOf(sql);
  for (const table of expectations(sql, plans)) {
    if (catalogue.get(table.table.toLowerCase()) !== 'table') continue;
    if (table.columns) {
      const present = columnsOn(sql, table.table);
      if (!table.columns.every((c) => present.has(c))) continue;
    }
    for (const d of table.derived) if (d.always || missingFrom(catalogue, d)) run(d.ddl);
  }
}
