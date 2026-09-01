/**
 * List indexes and the queries that use them, derived from a paged read's
 * `paged.over` declaration (#811, K-18).
 *
 * K-18 promised *"engine list APIs accept registry-declared filter/sort
 * predicates with correct pagination and counts, the kernel composing the join
 * inside the scope DB"* and nothing implemented it. This is that, and it takes
 * the same shape `searchables` took in #827 for the same reasons.
 *
 * ## Why the kernel owns this rather than a helper in contracts
 *
 * A fragment builder in `@substrat-run/contracts` could emit a correct
 * `WHERE status = ?` and a correct keyset comparison. It could not create the
 * INDEX behind either, because contracts sits below the migration machinery and
 * has no way to reach a scope's DDL. A declared filter with no index is a table
 * scan that passes every test, survives review, and degrades when one tenant's
 * table grows — the same delayed bug an unbounded list read is.
 *
 * That is what K-18 means by filter, sort key and index being *one declared
 * thing*: the third one is the reason it has to be here.
 *
 * ## What is derived, and what stays the handler's
 *
 * | Kernel | Handler |
 * |---|---|
 * | `WHERE` from declared filters, `ORDER BY` from the chosen sort, the keyset comparison, `LIMIT`, and the `COUNT` over the same `WHERE` | The projection, and any hydration — a `toWorkOrder`, a per-row aggregate, a second query for children |
 * | The indexes behind those, emitted as migrations and refused if unindexable | The permission check, which nothing on `ctx` ever does |
 *
 * The handler still writes its own `SELECT`, so this is not the generated-CRUD
 * layer `generated-verticals.md` §4 says does not exist: it invents no routes and
 * no handlers. It stops eleven call sites hand-writing the same cursor branch and
 * the same duplicated count `WHERE`.
 *
 * ## The tie-break, which is not optional
 *
 * A keyset walk over a NON-UNIQUE column drops and duplicates rows: order
 * `status ASC` with a cursor of `'open'` and every remaining `open` row is
 * skipped, because `status > 'open'` excludes its own ties. So every walk here
 * is over `(sortColumn, idColumn)` and the cursor is composite — which is the
 * `|`-joined form `pagination.ts` already pins ("first part always `|`-free").
 * Where the sort column IS the id, the pair collapses and the cursor is the bare
 * value, unchanged from what shipped.
 */
import type { SqlMigration } from './scope-host.js';

/**
 * One paged read's kernel-composed half, as the kernel needs it.
 *
 * `table` and `idColumn` are not authored — the same `manifestEntities()`-shaped
 * enrichment `searchables` gets fills them in from the entity registry, so there
 * is no second statement of where a work order lives to drift from the first.
 */
export interface ListDeclaration {
  /** The entity whose table the walk runs over. */
  readonly entityType: string;
  /** Columns a caller may sort by. The first is the default. */
  readonly sortable: readonly string[];
  /** Columns a caller may filter by equality on. */
  readonly filterable?: readonly string[];
  /** Filled in from the registry. */
  readonly table?: string;
  readonly idColumn?: string;
}

/** A resolved list declaration: everything the DDL and the query need. */
export interface ListIndexPlan {
  readonly moduleId: string;
  readonly entityType: string;
  readonly table: string;
  readonly idColumn: string;
  readonly sortable: readonly string[];
  readonly filterable: readonly string[];
  /** The index-name stem. Kernel-owned, so it carries the reserved prefix. */
  readonly indexStem: string;
}

/** The prefix every derived list index carries. */
export const LIST_INDEX_PREFIX = '_substrat_list_';

/** Is this index one the kernel derived for a paged read? */
export function isListIndexName(name: string): boolean {
  return name.startsWith(LIST_INDEX_PREFIX);
}

/**
 * SQL identifiers reach the DDL by interpolation — there is no parameter form
 * for a table or column name — so every one is checked first. Same reasoning as
 * `search-index.ts`: a declaration is still a string somebody typed, and "it came
 * from the manifest" is exactly the reasoning that makes an injection a surprise.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(kind: string, value: string, where: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`list: ${where} names ${kind} '${value}', which is not a plain SQL identifier`);
  }
  return value;
}

/** `@acme/vertical` → `acme_vertical`: an id is not an identifier, an index name needs one. */
function slug(value: string): string {
  return value
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/** Raised for an entity type no registered module declares as a paged list. */
export class NotListable extends Error {
  constructor(readonly entityType: string) {
    super(
      `list: '${entityType}' declares no paged list — add \`paged.over\` to the operation ` +
        'that reads it before paging through the kernel',
    );
    this.name = 'NotListable';
  }
}

/** Raised for a `?sort=` naming a column the declaration does not offer. */
export class SortNotDeclared extends Error {
  constructor(
    readonly entityType: string,
    readonly requested: string,
    readonly declared: readonly string[],
  ) {
    super(
      `list: '${requested}' is not a declared sort for '${entityType}' — ` +
        `choose one of (${declared.join(', ')})`,
    );
    this.name = 'SortNotDeclared';
  }
}

/** Raised for a filter naming a column the declaration does not offer. */
export class FilterNotDeclared extends Error {
  constructor(
    readonly entityType: string,
    readonly requested: string,
    readonly declared: readonly string[],
  ) {
    super(
      `list: '${requested}' is not a declared filter for '${entityType}' — ` +
        (declared.length
          ? `choose one of (${declared.join(', ')})`
          : 'it declares no filters at all'),
    );
    this.name = 'FilterNotDeclared';
  }
}

/**
 * Resolve one module's declarations into plans.
 *
 * Refuses rather than skips, for the reason `searchIndexPlans` does: a
 * declaration the author believes is live that silently is not produces a list
 * that pages wrongly with no error anywhere.
 */
export function listIndexPlans(
  moduleId: string,
  lists: readonly ListDeclaration[] | undefined,
): ListIndexPlan[] {
  if (!lists?.length) return [];
  const plans: ListIndexPlan[] = [];
  for (const decl of lists) {
    const where = `${moduleId} lists['${decl.entityType}']`;
    if (!decl.table) {
      throw new Error(
        `list: ${where} carries no table — declare paged lists through \`manifestLists()\` ` +
          'so the entity registry supplies it, rather than by hand',
      );
    }
    if (!decl.sortable.length) {
      throw new Error(
        `list: ${where} declares no sortable column — a keyset walk has nothing to order by`,
      );
    }
    const table = assertIdentifier('a table', decl.table, where);
    const idColumn = assertIdentifier('an id column', decl.idColumn ?? 'id', where);
    const sortable = decl.sortable.map((c) => assertIdentifier('a sort column', c, where));
    const filterable = (decl.filterable ?? []).map((c) =>
      assertIdentifier('a filter column', c, where),
    );
    if (new Set(sortable).size !== sortable.length) {
      throw new Error(`list: ${where} repeats a sortable column — (${sortable.join(', ')})`);
    }
    if (new Set(filterable).size !== filterable.length) {
      throw new Error(`list: ${where} repeats a filterable column — (${filterable.join(', ')})`);
    }
    plans.push({
      moduleId,
      entityType: decl.entityType,
      table,
      idColumn,
      sortable,
      filterable,
      indexStem: `${LIST_INDEX_PREFIX}${slug(moduleId)}_${slug(decl.entityType)}`,
    });
  }
  return plans;
}

/**
 * The index columns for one walk: the sort, then the tie-break, prefixed by a
 * filter when the walk narrows by one.
 *
 * **One index per (filter, sort) pair, plus one per bare sort** — deliberately
 * not every subset of the filters. `S × 2^F` indexes is a combinatorial answer
 * to a question nobody asked: two filters applied together use the leftmost
 * index and narrow the rest by scan, which for a filtered page is the right
 * trade against paying write amplification on every insert forever.
 *
 * Stated rather than left implicit because it is a real limit: a list whose
 * two-filter combination is hot wants a hand-written index, and knowing that is
 * how somebody adds one.
 */
export function listIndexColumns(plan: ListIndexPlan): { name: string; columns: string[] }[] {
  const out: { name: string; columns: string[] }[] = [];
  for (const sort of plan.sortable) {
    // The tie-break collapses when the sort column IS the id — indexing
    // `(id, id)` would be a wider index describing the same order.
    const walk = sort === plan.idColumn ? [sort] : [sort, plan.idColumn];
    // Sorting by the id alone needs no index of ours: the id column is the
    // entity's primary key by construction (`primaryKeyOf` resolved it), and
    // SQLite already indexes that. Emitting one would pay write amplification on
    // every insert for a second copy of an index that exists.
    if (walk.length > 1) {
      out.push({ name: `${plan.indexStem}_${slug(sort)}`, columns: walk });
    }
    for (const filter of plan.filterable) {
      if (filter === sort) continue;
      out.push({
        name: `${plan.indexStem}_${slug(filter)}_${slug(sort)}`,
        columns: [filter, ...walk],
      });
    }
  }
  return out;
}

/**
 * The DDL for one plan's indexes.
 *
 * Drop-then-create, like the search index and for the same reason: the version
 * below is the declaration itself, so a changed declaration re-runs this and has
 * to produce indexes matching the NEW declaration rather than accumulating the
 * old ones. An index is derived data; nothing is lost by dropping it.
 */
export function listIndexDdl(plan: ListIndexPlan): string {
  const lines: string[] = [];
  for (const idx of listIndexColumns(plan)) {
    lines.push(`DROP INDEX IF EXISTS ${idx.name};`);
    lines.push(`CREATE INDEX ${idx.name} ON ${plan.table} (${idx.columns.join(', ')});`);
  }
  return lines.join('\n');
}

/**
 * The migrations that provision a module's declared list indexes, journaled like
 * any other so a scope applies them once and a changed declaration re-applies.
 *
 * **The version IS the declaration**, as it is for search: everything that
 * decides the DDL appears in the version string, so adding a sort produces a new
 * version and re-runs while changing nothing does not. Legible in
 * `_substrat_migrations`, which is the one place an operator reads when a scope
 * is stuck.
 *
 * Appended AFTER the module's own migrations by the adapter, which is what makes
 * the table exist by the time `CREATE INDEX` names it.
 */
export function listIndexMigrations(
  moduleId: string,
  lists: readonly ListDeclaration[] | undefined,
): SqlMigration[] {
  return listIndexPlans(moduleId, lists).map((plan) => ({
    version: `list/${plan.entityType}:${plan.sortable.join('+')}:${plan.filterable.join('+')}`,
    sql: listIndexDdl(plan),
  }));
}

/**
 * Index the plans by entity type for a whole scope, refusing an ambiguity — the
 * same refusal `searchPlansByEntityType` makes, because `ctx.page('customer', …)`
 * meaning different rows depending on registration order is the kind of fact
 * that stays true in tests and changes in production.
 */
export function listPlansByEntityType(
  modules: readonly { readonly id: string; readonly lists?: readonly ListDeclaration[] }[],
): Map<string, ListIndexPlan> {
  const byType = new Map<string, ListIndexPlan>();
  for (const mod of modules) {
    for (const plan of listIndexPlans(mod.id, mod.lists)) {
      const existing = byType.get(plan.entityType);
      if (existing) {
        throw new Error(
          `list: '${plan.entityType}' declares a paged list in both '${existing.moduleId}' and ` +
            `'${plan.moduleId}' — one entity type, one walk; rename one`,
        );
      }
      byType.set(plan.entityType, plan);
    }
  }
  return byType;
}

/** What a caller asks for. Everything optional but the limit, which the host defaults. */
export interface ListQueryParams {
  readonly limit: number;
  readonly sort?: string;
  readonly order?: 'asc' | 'desc';
  readonly cursor?: string;
  /**
   * Narrowing, per declared column. A scalar is an equality; an ARRAY is the set
   * of permitted values (`IN`), and an empty array permits none of them.
   */
  readonly filters?: Readonly<Record<string, unknown>>;
}

/** A composed read: the page query, and the count over the same `WHERE`. */
export interface ComposedListQuery {
  readonly sql: string;
  readonly params: unknown[];
  readonly countSql: string;
  readonly countParams: unknown[];
  /** The column the walk ordered by — what the cursor's first part came from. */
  readonly sortColumn: string;
  readonly order: 'asc' | 'desc';
}

/**
 * Split a composite cursor into its sort value and its tie-break id.
 *
 * The first part is `|`-free by construction (`pagination.ts`), so the split is
 * on the FIRST separator and a sort value containing `|` still round-trips as
 * long as the id does not — which it cannot, being a ULID.
 */
export function splitCursor(cursor: string): { value: string; id: string | undefined } {
  const at = cursor.indexOf('|');
  if (at === -1) return { value: cursor, id: undefined };
  return { value: cursor.slice(0, at), id: cursor.slice(at + 1) };
}

/** Build the cursor a row hands to the next page. */
export function cursorOf(row: Record<string, unknown>, sortColumn: string, idColumn: string): string {
  const value = String(row[sortColumn] ?? '');
  if (sortColumn === idColumn) return value;
  return `${value}|${String(row[idColumn] ?? '')}`;
}

/**
 * Compose the page query and its count.
 *
 * The two share one `WHERE` **by construction** rather than by being written
 * twice in the same style — which is the defect `CountedPage` warns about ("a
 * count of the whole table beside a filtered page is a number that is wrong in a
 * way nobody notices until a customer does"). The count deliberately drops the
 * CURSOR clause: a total counts the filtered set, not the part of it after the
 * current page.
 */
export function listQuery(plan: ListIndexPlan, params: ListQueryParams): ComposedListQuery {
  const sortColumn = params.sort ?? (plan.sortable[0] as string);
  if (!plan.sortable.includes(sortColumn)) {
    throw new SortNotDeclared(plan.entityType, sortColumn, plan.sortable);
  }
  const order = params.order ?? 'asc';
  const filters = Object.entries(params.filters ?? {}).filter(([, v]) => v !== undefined);
  const where: string[] = [];
  const args: unknown[] = [];
  for (const [column, value] of filters) {
    if (!plan.filterable.includes(column)) {
      throw new FilterNotDeclared(plan.entityType, column, plan.filterable);
    }
    // A SET of permitted values, not a second operator.
    //
    // Equality is the only predicate this composes, because `filterable`
    // provisions an index per column and a set of equalities still uses it. What
    // an array buys is the read a single `=` cannot state at all: "every state
    // except the terminal one" — ticket0's inbox, which must not surface closed
    // conversations by default and has four states that are not `closed`. The
    // alternative was four requests whose pages cannot be merged, or a `!=` that
    // would make `filterable` mean something wider than "indexed equality".
    if (Array.isArray(value)) {
      // An empty set permits nothing, and that is a fact, not a mistake: a caller
      // that narrowed to nothing gets no rows rather than every row, which is what
      // dropping the clause would quietly hand back.
      if (value.length === 0) {
        where.push('0 = 1');
        continue;
      }
      where.push(`${column} IN (${value.map(() => '?').join(', ')})`);
      args.push(...value);
      continue;
    }
    where.push(`${column} = ?`);
    args.push(value);
  }
  // The count runs over the filters ALONE — the cursor narrows a page, not the set.
  const countWhere = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const countParams = [...args];

  const cmp = order === 'asc' ? '>' : '<';
  if (params.cursor !== undefined && params.cursor !== '') {
    const { value, id } = splitCursor(params.cursor);
    if (sortColumn === plan.idColumn || id === undefined) {
      where.push(`${sortColumn} ${cmp} ?`);
      args.push(value);
    } else {
      // Keyset over (sort, id): strictly past the sort value, or level with it
      // and strictly past the id. Written out rather than as a row-value
      // comparison — SQLite supports `(a,b) > (?,?)` only from 3.15 and the
      // expanded form plans identically against the same index.
      where.push(`(${sortColumn} ${cmp} ? OR (${sortColumn} = ? AND ${plan.idColumn} ${cmp} ?))`);
      args.push(value, value, id);
    }
  }
  const whereClause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const orderBy =
    sortColumn === plan.idColumn
      ? ` ORDER BY ${sortColumn} ${direction}`
      : ` ORDER BY ${sortColumn} ${direction}, ${plan.idColumn} ${direction}`;
  return {
    sql: `SELECT * FROM ${plan.table}${whereClause}${orderBy} LIMIT ?`,
    params: [...args, params.limit],
    countSql: `SELECT COUNT(*) AS n FROM ${plan.table}${countWhere}`,
    countParams,
    sortColumn,
    order,
  };
}
