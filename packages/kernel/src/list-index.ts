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
 * Where the sort column IS the id, the pair collapses and the cursor carries the
 * id alone (its envelope has no separate `id`, K-44).
 */
import { PAGE_CURSOR_RESTART, SubstratError, ULID_PATTERN, z } from '@substrat-run/contracts';
import { fromBase64url, toBase64url } from './base64url.js';
import type { EntityStateDeclaration, EntityStateName } from '@substrat-run/contracts';
import { entityStatePlans, entityStateWhere, stateColumnsOf, viewsOf, type StateColumns } from './entity-state.js';
import type { DerivedObject } from './derived-object.js';
import type { SqlMigration } from './scope-host.js';
import { SQL_IDENTIFIER, assertSqlIdentifier } from './sql-identifier.js';

declare const TextEncoder: new () => { encode(input: string): Uint8Array };
declare const TextDecoder: new (label: string, options: { fatal: boolean }) => { decode(input: Uint8Array): string };

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
  /**
   * The entity's archive/trash columns, when it declares either (#119). Present, every index
   * is PARTIAL — one per view — and every walk is narrowed to one view.
   */
  readonly states?: StateColumns;
}

/** The prefix every derived list index carries. */
const LIST_INDEX_PREFIX = '_substrat_list_';

const assertIdentifier = (kind: string, value: string, where: string): string =>
  assertSqlIdentifier('list', kind, value, where);

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
  /** The SAME module's archive/trash declarations (#119) — its table, its columns. */
  entityStates?: readonly EntityStateDeclaration[],
): ListIndexPlan[] {
  if (!lists?.length) return [];
  const states = new Map(entityStatePlans(moduleId, entityStates).map((p) => [p.entityType, stateColumnsOf(p)]));
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
      ...(states.has(decl.entityType) ? { states: states.get(decl.entityType) } : {}),
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
function listIndexColumns(
  plan: ListIndexPlan,
): { name: string; columns: string[]; where?: string }[] {
  const out: { name: string; columns: string[]; where?: string }[] = [];
  for (const sort of plan.sortable) {
    // The tie-break collapses when the sort column IS the id — indexing
    // `(id, id)` would be a wider index describing the same order.
    const walk = sort === plan.idColumn ? [sort] : [sort, plan.idColumn];
    // Sorting by the id alone needs no index of ours: the id column is the
    // entity's primary key by construction (`primaryKeyOf` resolved it), and
    // SQLite already indexes that. Emitting one would pay write amplification on
    // every insert for a second copy of an index that exists.
    //
    // UNLESS the entity is archivable (#119): then every walk is narrowed to a view, and the
    // primary key would walk past every archived row to find the active ones — the archive is
    // exactly the part of the table that grows without bound. A partial index per view is
    // the fix, and it costs no more to write than the one full index it replaces: each row
    // sits in exactly one view, so it is entered in exactly one of them.
    if (walk.length > 1 || plan.states) {
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
  if (!plan.states) return out;
  // One partial index per view. The ACTIVE one keeps the name the full index had, so a scope
  // that had the full index has it replaced rather than kept beside the partial one.
  const states = plan.states;
  return out.flatMap((idx) =>
    viewsOf(states).map((view) => ({
      name: view === 'active' ? idx.name : `${idx.name}_${view}`,
      columns: idx.columns,
      where: entityStateWhere(plan.entityType, states, view),
    })),
  );
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
  return listIndexObjects(plan)
    .flatMap((idx) => [`DROP INDEX IF EXISTS ${idx.name};`, `${idx.sql};`])
    .join('\n');
}

/** The plan's indexes, each with its CREATE statement — what `listIndexDdl` runs. */
export function listIndexObjects(plan: ListIndexPlan): DerivedObject[] {
  return listIndexColumns(plan).map((idx) => ({
    name: idx.name,
    type: 'index',
    table: plan.table,
    sql: `CREATE INDEX ${idx.name} ON ${plan.table} (${idx.columns.join(', ')})${idx.where ? ` WHERE ${idx.where}` : ''}`,
  }));
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
  entityStates?: readonly EntityStateDeclaration[],
): SqlMigration[] {
  return listIndexPlans(moduleId, lists, entityStates).map((plan) => ({
    version: listIndexVersion(plan),
    sql: listIndexDdl(plan),
  }));
}

/**
 * One plan's migration version. The views are part of the declaration the DDL depends on
 * (#119): declaring a trash makes every index partial, so the version moves and the indexes
 * are rebuilt.
 */
export const listIndexVersion = (plan: ListIndexPlan): string =>
  `list/${plan.entityType}:${plan.sortable.join('+')}:${plan.filterable.join('+')}` +
  (plan.states ? `:${viewsOf(plan.states).join('+')}` : '');

/** What a caller asks for. Everything optional but the limit, which the host defaults. */
export interface ListQueryParams {
  readonly limit: number;
  readonly sort?: string;
  readonly order?: 'asc' | 'desc';
  readonly cursor?: string;
  /**
   * Narrowing, per declared column. A scalar is an equality; an ARRAY is the set
   * of permitted values (`IN`), and an empty array permits none of them; `null` is
   * the rows with no value there (`IS NULL`).
   */
  readonly filters?: Readonly<Record<string, unknown>>;
  /**
   * Which rows (#119). `active` when unset — an archived or trashed row is never in a page
   * nobody asked to see it in. Refused for an entity that declares no such view.
   */
  readonly view?: EntityStateName;
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
  /** The view the walk ran over (#119) — what its cursors are minted for. */
  readonly view: EntityStateName;
}

/**
 * Raised for a cursor this walk cannot continue (#2001): one minted under a
 * different order or sort, or one `ctx.page` never minted at all.
 *
 * A keyset position only means something in the walk that produced it. Replayed
 * under the other order, `created_at < ?` becomes `created_at > ?` over the same
 * value and the "next" page is the rows the caller has already seen — a silent
 * answer that reads as a working list. So the cursor names its walk, and a
 * disagreement is the caller's 400, narrowed by `reason: 'cursor_restart'` so a
 * client can tell "read the first page again" from a malformed request.
 */
export class CursorMismatch extends SubstratError {
  constructor(message: string) {
    // A SEMANTIC refusal, so no `errors` list: that list is what marks a parse failure,
    // and `toProblem` would trade this sentence and its reason for "did not parse".
    super('validation_failed', message, { reason: PAGE_CURSOR_RESTART });
  }
}

/**
 * The cursor `ctx.page` mints: base64url of `{ v: 1, order, sort, value, id? }` (K-44).
 *
 * Opaque and versioned, and **distinct from a pre-#2001 cursor by construction**, not by
 * a guess at what a sort value might look like. A legacy cursor is either `<value>|<id>`,
 * which carries a `|` that base64url never emits, or a bare ULID, whose first character
 * (a timestamp digit) can never decode to the `{` an envelope always starts with. A
 * readable prefix such as `asc.name.` could not promise that: a row named `asc.name.foo`
 * minted exactly that legacy cursor (#2018 review).
 *
 * `id` is present exactly when the walk sorts by something other than the id itself.
 *
 * `view` (#119) names an archivable entity's view when it is not `active`. A position in the
 * active rows means nothing among the archived ones: replayed there, `id > ?` silently skips
 * every archived row before it. Absent means active, so every cursor minted before it — and
 * every active one since — reads the same, and a change of view is a `cursor_restart`.
 */
const cursorEnvelope = z.strictObject({
  v: z.literal(1),
  order: z.enum(['asc', 'desc']),
  sort: z.string().regex(SQL_IDENTIFIER),
  value: z.string(),
  id: z.string().optional(),
  view: z.enum(['archived', 'trashed']).optional(),
});

/** Build the cursor a row hands to the next page — the walk that minted it, and where. */
export function cursorOf(
  row: Record<string, unknown>,
  sortColumn: string,
  idColumn: string,
  order: 'asc' | 'desc',
  /** The walk's view (#119). `active`, or unset, is left out of the envelope. */
  view?: EntityStateName,
): string {
  const envelope: z.infer<typeof cursorEnvelope> = {
    v: 1,
    order,
    sort: sortColumn,
    value: String(row[sortColumn] ?? ''),
    ...(sortColumn === idColumn ? {} : { id: String(row[idColumn] ?? '') }),
    ...(view && view !== 'active' ? { view } : {}),
  };
  return toBase64url(new TextEncoder().encode(JSON.stringify(envelope)));
}

/** The envelope a cursor decodes to, or `undefined` when it is not one — every field checked. */
function envelopeOf(cursor: string): z.infer<typeof cursorEnvelope> | undefined {
  const bytes = fromBase64url(cursor);
  if (!bytes) return undefined;
  try {
    return cursorEnvelope.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    return undefined;
  }
}

/** Migration gate for filtered walks: their old input was a plain ctx.page cursor. */
export function isPlainPageCursor(cursor: string): boolean {
  if (envelopeOf(cursor)) return true;
  if (ULID_PATTERN.test(cursor)) return true;
  const at = cursor.lastIndexOf('|');
  return at >= 0 && ULID_PATTERN.test(cursor.slice(at + 1));
}

/**
 * A pre-#2001 cursor, recognised only by its exact old shape: `<value>|<id>` with the
 * id a ULID, or — for a walk sorted by the id itself — the bare ULID. Split on the LAST
 * `|`, which a ULID cannot contain, so a value that holds one still comes back whole.
 */
function legacyPositionOf(
  cursor: string,
  plan: ListIndexPlan,
  sortColumn: string,
): { value: string; id: string | undefined } | undefined {
  if (sortColumn === plan.idColumn) return ULID_PATTERN.test(cursor) ? { value: cursor, id: undefined } : undefined;
  const at = cursor.lastIndexOf('|');
  if (at === -1) return undefined;
  const id = cursor.slice(at + 1);
  return ULID_PATTERN.test(id) ? { value: cursor.slice(0, at), id } : undefined;
}

/**
 * The position a cursor holds in THIS walk, or a refusal.
 *
 * An envelope is continued only in the walk it names. A legacy cursor was minted under
 * the ONLY default there was — ascending, by the first declared sort — so it is continued
 * exactly there (an in-flight walk survives the deploy) and refused anywhere else, which
 * is where it would replay silently: under a newly honoured `desc` default above all.
 * Anything that is neither is refused too. Every refusal is the same `cursor_restart`.
 */
function positionIn(
  cursor: string,
  plan: ListIndexPlan,
  sortColumn: string,
  order: 'asc' | 'desc',
  view: EntityStateName,
): { value: string; id: string | undefined } {
  const envelope = envelopeOf(cursor);
  if (envelope) {
    const minted = envelope.view ?? 'active';
    if (minted !== view) {
      throw new CursorMismatch(
        `list: this cursor continues the ${minted} rows, and this request asks for the ${view} ones — ` +
          'restart paging from the first page, without a cursor',
      );
    }
    if (envelope.order !== order || envelope.sort !== sortColumn) {
      throw new CursorMismatch(
        `list: this cursor continues a walk by '${envelope.sort}' ${envelope.order}, and this request ` +
          `asks for '${sortColumn}' ${order} — keep the sort and order the first page was read with, ` +
          'or restart paging from the first page, without a cursor',
      );
    }
    if ((envelope.id === undefined) !== (sortColumn === plan.idColumn)) {
      throw new CursorMismatch('list: this cursor is malformed — restart paging from the first page, without a cursor');
    }
    return { value: envelope.value, id: envelope.id };
  }
  const legacy = legacyPositionOf(cursor, plan, sortColumn);
  // Every legacy cursor predates the views, so it was minted over the active rows (#119).
  if (legacy && order === 'asc' && sortColumn === plan.sortable[0] && view === 'active') return legacy;
  throw new CursorMismatch(
    legacy
      ? `list: this cursor predates the walk it is replayed in ('${sortColumn}' ${order}) — ` +
          'restart paging from the first page, without a cursor'
      : 'list: this cursor was not minted by this list — restart paging from the first page, without a cursor',
  );
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
  // The view first, in the exact words the partial index was created with — SQLite uses a
  // partial index only when the query's WHERE carries its terms.
  const view = entityStateWhere(plan.entityType, plan.states, params.view);
  if (view) where.push(view);
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
      // ONE bound JSON array, not a `?` per member: the set is the caller's, a Durable Object
      // allows 100 bound parameters in a whole statement, and this one also carries the cursor
      // and the page size (#1741). `json_each` yields the members with their own types.
      where.push(`${column} IN (SELECT value FROM json_each(?))`);
      args.push(JSON.stringify(value));
      continue;
    }
    // `null` asks for the rows that HOLD no value, and only `IS NULL` can say that:
    // `= NULL` is never true, so it used to answer an empty page that read as "none
    // match" (#1088). A nullable column whose absence means something — ticket0's
    // `quarantine`, where null is the inbox — needs this to be listable at all. The
    // column's index still serves it: SQLite seeks `IS NULL` like an equality.
    if (value === null) {
      where.push(`${column} IS NULL`);
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
    const { value, id } = positionIn(params.cursor, plan, sortColumn, order, params.view ?? 'active');
    if (id === undefined) {
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
    view: params.view ?? 'active',
  };
}
