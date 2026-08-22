/**
 * The operation surface of the model (#707).
 *
 * #697 declared the entities. This declares what can be *done* to them, and
 * checks the joins that today are unchecked strings: which permission an
 * operation requires, which output field an event takes its subject from,
 * whether a payload carries something an erasure must be able to reach.
 *
 * ## A composer, not a second `defineModel`
 *
 * `defineOperations` sits beside `defineEntities` rather than swallowing it.
 * Each half stays independently adoptable — which is what let the entity half
 * ship and be taken up by two verticals before this existed. A vertical adopts
 * operations when it is ready, not as the price of adopting entities.
 *
 * ## `input`, and the transcription that is not here
 *
 * `input` is the Zod object the handler already parses — the same object, not a
 * description of it. That is the whole reason the model is TypeScript (#680): a
 * schema language would need the shape written twice, and transcription is what
 * produced 40 wrong argument names in the one app where this was measured.
 */
import type { CountedPage, Page } from './pagination.js';
import { z } from 'zod';
import { primaryKeyOf, type EntityDef, type EntityFields } from './model.js';

// ---------------------------------------------------------------------------
// Reading an operation's own declarations back off itself.
// ---------------------------------------------------------------------------

/** `{var}` names in a literal path. */
type PathParams<S extends string> = S extends `${string}{${infer P}}${infer Rest}`
  ? P | PathParams<Rest>
  : never;

type InputKeys<O> = O extends { input: infer I } ? (I extends z.ZodType ? keyof z.infer<I> & string : never) : never;

type OutputKeys<O> = O extends { output: infer R } ? (R extends z.ZodType ? keyof z.infer<R> & string : never) : never;

/** Every `{var}` must name an input field, or the path type collapses. */
type CheckedPath<O> = O extends { http: { path: infer P } }
  ? P extends string
    ? [PathParams<P>] extends [InputKeys<O>]
      ? P
      : never
    : never
  : string;

/**
 * The erasable fields OF THE ENTITY THIS EVENT IS ABOUT.
 *
 * Resolving through `emits.entity` rather than matching field names across all
 * entities is what makes the §12 check exact. A `contactPerson.email` marked
 * erasable must not stop an event about an `office` carrying its own `email` —
 * a rule that refuses correct code trains people to route around it, which is
 * how a PII rule stops being obeyed.
 */
type ErasableOf<Entities, Engines, O> = O extends { emits: { entity: infer N } }
  ? N extends keyof Entities
    ? Entities[N] extends { erasable: readonly (infer F)[] }
      ? F & string
      : never
    : // The event may be about a COMPOSED ENGINE's entity, in which case the
      // erasable set is the engine's — its declaration, not ours.
      Engines extends readonly (infer R)[]
      ? R extends Record<string, EntityDef>
        ? N extends keyof R
          ? R[N] extends { erasable: readonly (infer F)[] }
            ? F & string
            : never
          : never
        : never
      : never
  : never;

/**
 * The platform's own event invariant, moved from runtime to compile time.
 * `contracts/events.ts` enforces it with a `superRefine`: *"subjectId is
 * required when piiClass is 'direct' — crypto-shredding must be able to key the
 * erasure"*. Classification is mandatory here for the same reason it is there:
 * an unclassified event type cannot be declared.
 */
type PiiShape<O, OutKeys extends string> = O extends { emits: { piiClass: 'none' } }
  ? { readonly piiClass: 'none'; readonly subjectId?: never }
  : { readonly piiClass: 'pseudonymous' | 'direct'; readonly subjectId: OutKeys };

/**
 * An operation carries a leading `permission` OR `narrows` with a reason, never
 * both and never neither (rule 5 / CRM-EFF's check 14). `narrows` is the
 * per-row proof walk: a salesperson listing their own customers must get their
 * list, not a denial.
 */
/**
 * What a leading `permission` actually checks — the node, or one entity.
 *
 * A bare key was ambiguous, and ambiguous in the direction that fails OPEN.
 * These two read identically in the model and behave completely differently:
 *
 * ```ts
 * 'todo/create-list': { permission: 'list:create', … }   // checked at the scope
 * 'todo/rename-list': { permission: 'list:manage', … }   // checked on ONE list
 * ```
 *
 * Only the handler decided which, via `ctx.check(perm)` versus
 * `ctx.check(perm, entityRef)`. Get it wrong in the second case and the
 * operation passes for anyone holding the key anywhere in the scope — in a
 * sharing app, any member editing any record — with every test still green,
 * because a seed that grants nothing scope-wide is the only thing that would
 * have caught it.
 *
 * So an entity-narrowed check says so, and says what it narrows to:
 *
 * ```ts
 * permission: { key: 'list:manage', entity: 'list', idFrom: 'listId' }
 * ```
 *
 * `idFrom` names the input field carrying the entity's id, so the check is
 * derivable. When the id is not in the input — `set-item-done` takes an item and
 * checks the LIST it sits on — say `resolved` instead with the reason. That
 * still records the thing that matters (this is not a node check) while being
 * honest that the handler has to find the entity itself.
 */
type PermissionCheck<O, Entities, Engines, PermKey extends string> = {
  readonly key: PermKey;
  /**
   * The entity type the check narrows to — this module's, or a composed engine's.
   *
   * Pointable only. A narrowed check is a grant against ONE entity id, and
   * `idFrom` names the single input field carrying it, so a composite-keyed
   * table has nothing to narrow to. Inlined rather than aliased, per
   * `PointableName` in `model.ts`.
   */
  readonly entity:
    | ({
        readonly [K in keyof Entities]: Entities[K] extends {
          primaryKey: readonly [unknown, unknown, ...unknown[]];
        }
          ? never
          : K;
      }[keyof Entities] &
        string)
    | (Engines extends readonly (infer R)[]
        ? R extends Record<string, EntityDef>
          ? {
              readonly [K in keyof R]: R[K] extends { primaryKey: readonly [unknown, unknown, ...unknown[]] }
                ? never
                : K;
            }[keyof R] &
              string
          : never
        : never);
} & (
  | { readonly idFrom: InputKeys<O>; readonly resolved?: never }
  | { readonly resolved: string; readonly idFrom?: never }
);

type OpAuthority<O, Entities, Engines, PermKey extends string> = O extends { narrows: unknown }
  ? {
      readonly narrows: {
        readonly reason: string;
        /**
         * THIS module's permission keys the walk evaluates per entity.
         *
         * Required, and empty is a legitimate answer — the point is that it is
         * stated. Without it a key reached only by a proof walk contributes
         * nothing to the derived permission list and vanishes from the review
         * artifact, which is the one place a widened permission is supposed to
         * be impossible to miss.
         *
         * A walk may also check a COMPOSED ENGINE's key (Callout's portal walk
         * checks `workorder:read`). Those are deliberately not listed: the
         * engine's own manifest declares them, and a vertical restating another
         * module's permissions is the same two-descriptions defect this exists
         * to prevent.
         */
        readonly checks: readonly PermKey[];
      };
      readonly permission?: never;
    }
  : {
      readonly permission: PermKey | PermissionCheck<O, Entities, Engines, PermKey>;
      readonly narrows?: never;
    };

/**
 * The field names of the entity NAMED by `paged.over.entity` — this module's, or
 * a composed engine's. Resolved through the name rather than matched across all
 * entities, for the reason `ErasableOf` is: a `status` column on one entity must
 * not make `status` sortable on another.
 */
export type FieldsOfNamed<Entities, Engines, N> = N extends keyof Entities
  ? EntityFields<Entities[N]>
  : Engines extends readonly (infer R)[]
    ? R extends Record<string, EntityDef>
      ? N extends keyof R
        ? EntityFields<R[N]>
        : never
      : never
    : never;

/** The entity `paged.over` names, read back off the operation's own declaration. */
export type PagedEntityOf<O> = O extends { paged: { over: { entity: infer N } } } ? N : never;

/**
 * The kernel-composed half of a paged read (#811, K-18).
 *
 * Present means the KERNEL builds the walk over this entity's table: the `WHERE`
 * from `filterable`, the `ORDER BY` from the caller's choice among `sortable`,
 * the keyset comparison, the `LIMIT`, and — when `total` is on — the `COUNT` over
 * that same `WHERE`. It also emits the INDEXES behind them, which is the reason
 * this lives in the kernel at all and not in a query helper here: contracts sits
 * below the migration machinery, and a declared filter with no index is a table
 * scan that passes every test and degrades when one tenant's table grows.
 *
 * The handler still writes its own `SELECT` — it receives a page of ROWS and maps
 * or hydrates it with `mapPage`. So this is not a CRUD layer: it invents no
 * routes and no handlers.
 */
export type PagedOver<O, Entities, Engines> = {
  /**
   * The entity whose table the walk runs over.
   *
   * Pointable only, and for a reason particular to paging: a keyset walk over a
   * non-unique column needs a single-column tie-break to avoid skipping ties, and
   * a table keyed by `(customer_id, year, month)` has no one column to break on.
   * Inlined rather than aliased, per `PointableName` in `model.ts`.
   */
  readonly entity:
    | ({
        readonly [K in keyof Entities]: Entities[K] extends {
          primaryKey: readonly [unknown, unknown, ...unknown[]];
        }
          ? never
          : K;
      }[keyof Entities] &
        string)
    | (Engines extends readonly (infer R)[]
        ? R extends Record<string, EntityDef>
          ? {
              readonly [K in keyof R]: R[K] extends { primaryKey: readonly [unknown, unknown, ...unknown[]] }
                ? never
                : K;
            }[keyof R] &
              string
          : never
        : never);
  /**
   * Columns a caller may sort by, via `?sort=`. **The first is the default**, so
   * the order of this array is a fact and not a style — which is why it is not
   * sorted on emit.
   *
   * A vertical wanting a sort the engine did not declare is the signal CLAUDE.md
   * names: add it here, rather than fork.
   */
  readonly sortable: readonly FieldsOfNamed<Entities, Engines, PagedEntityOf<O>>[];
  /**
   * Columns a caller may filter by equality on. Each becomes a query parameter in
   * the emitted document and a `(filter, sort, id)` index in the scope.
   *
   * Equality only, deliberately. Ranges, `IN`, `LIKE` and boolean composition are
   * where a filter vocabulary becomes a query language, and BPMN-in-TypeScript is
   * the tarpit master-plan.md already named. A read that needs more than equality
   * is an operation with its own name and its own arguments.
   */
  readonly filterable?: readonly FieldsOfNamed<Entities, Engines, PagedEntityOf<O>>[];
};

/** What every paged read declares, whoever composes the query. */
export interface PagedCommon {
  /** Walk direction. Defaults to `asc`; a feed reading newest-first says `desc`. */
  readonly order?: 'asc' | 'desc';
  /**
   * Also return `total` — the count of rows matching this list's filter.
   *
   * Opt-in, because a keyset page cannot produce one for free: it is a second
   * query per request. Say `true` where a screen renders `1–20 of 340`, which in
   * business software is most tables and in a feed is none of them. The handler
   * must then return `countedPageOf`, and the compiler holds it to that.
   */
  readonly total?: boolean;
}

/**
 * This read returns a PAGE, not the whole table (#811, #129).
 *
 * A list endpoint that returns everything is a bug with a delay on it: it passes
 * review, it passes tests, and then one tenant's table gets large. Declaring
 * `paged` is what lets that be caught mechanically rather than noticed — see the
 * `lint:model` gate, which refuses a bare `z.array()` output that does not.
 *
 * `output` declares the **entry** shape either way, and the platform wraps it: the
 * emitted document gains its query parameters and the handler returns
 * `Page<Entry>`. Declaring the entry rather than the envelope is what keeps the
 * sort checkable and stops twelve operations restating the same wrapper.
 *
 * ## Two halves, and which one a read is
 *
 * A UNION rather than one shape with optional fields, because the two describe
 * the same fact from opposite ends and stating both would let them disagree:
 *
 * - **`over`** — the kernel composes the query (see `PagedOver`). The cursor is
 *   the sort COLUMN's value, so there is no entry field to name.
 * - **`sortKey`** — the handler composes its own SQL and calls `pageOf`. The
 *   cursor is read off the ENTRY, so it names an output field.
 *
 * The second is not a legacy path. Three of the platform's own reads cannot be
 * kernel-composed and are not defects: `callout/timeline` walks `_substrat_outbox`
 * (a kernel table, not a declared entity), `protocol/list-templates` selects
 * through a correlated `MAX(version)` subquery, and `callout/portal-orders`
 * filters per row by permission. They still page, still carry a cursor, and still
 * satisfy the gate — they just own their own `WHERE`.
 *
 * Which half a read is, is a fact about its declaration; an absent `over` reads as
 * intent, the same way an engine's composition mode does.
 */
export type PagedShape<O, Entities, Engines> =
  | (PagedCommon & {
      /**
       * The OUTPUT field the cursor walks — the same compile-checked join as
       * `entityIdFrom`, and for the same reason: a cursor over a field the entry
       * does not have is a page that silently skips or repeats rows, and nothing
       * downstream would ever flag it. Keyset, never offset: on live data an
       * offset shifts between requests, so pages drop and duplicate.
       */
      readonly sortKey: OutputKeys<O>;
      readonly over?: never;
    })
  | (PagedCommon & {
      readonly over: PagedOver<O, Entities, Engines>;
      readonly sortKey?: never;
    });

/**
 * The per-operation constraint, self-referential in `O`.
 *
 * Each operation is checked against ITS OWN declared input and output rather
 * than an erased supertype. Written the obvious way every check below compiles
 * clean and enforces nothing — see `test/operations.test.ts`, which exists to
 * prove they still bite.
 */
type OperationShape<O, Entities, Engines, PermKey extends string> = {
  /** One line, imperative — what invoking this does. Feeds the API document. */
  readonly summary: string;
  /**
   * The request body — the SAME Zod object the handler parses.
   *
   * **Omitted means no body at all**, and the handler then takes `undefined`.
   * Found by the first adopter: three of Callout's six operations take no input,
   * and a required `z.object({})` cannot say so — a handler accepting only
   * `undefined` is not assignable to one accepting `{}`.
   *
   * This mirrors `ApiOperationDoc.input` ("Omit = no body") rather than
   * inventing a second vocabulary for the same fact.
   */
  readonly input?: z.ZodObject<z.ZodRawShape>;
  /** True when the handler accepts a body but also accepts none (filter-style reads). */
  readonly inputOptional?: boolean;
  /**
   * Declared, not inferred (#695 Ask 2). Inference documents accidents: one
   * inferred return carried `contacts?: undefined`, an artefact of an early
   * return, which generation would have cemented into the published API.
   *
   * Declare a return where a caller branches on it — a UI lane is a caller that
   * branches, which is why #682/#683 depend on this.
   */
  readonly output: z.ZodType;
  readonly http?: {
    readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    readonly path: CheckedPath<O>;
  };
  /**
   * This read returns a PAGE, not the whole table (#811, #129).
   *
   * A list endpoint that returns everything is a bug with a delay on it: it passes
   * review, it passes tests, and then one tenant's table gets large. Declaring
   * `paged` is what lets that be caught mechanically rather than noticed.
   *
   * When present, `output` declares the **entry** shape and the platform wraps it:
   * the emitted document gains `limit` / `cursor` / `order` query parameters and a
   * `{ entries, nextCursor }` envelope, and the handler returns `Page<Entry>`
   * (`pageOf` builds one). Declaring the entry rather than the envelope is what
   * keeps `sortKey` checkable and stops twelve operations from restating the same
   * wrapper.
   *
   * `sortKey` names the output field the cursor walks — the same compile-checked
   * join as `entityIdFrom`, and for the same reason: a cursor over a field the
   * entry does not have is a page that silently skips or repeats rows, and nothing
   * downstream would ever flag it. Keyset, never offset: on live data an offset
   * shifts between requests, so pages drop and duplicate.
   */
  readonly paged?: PagedShape<O, Entities, Engines>;
  readonly emits?: {
    /**
     * The entity the event is about — one of THIS module's entities, or one of a
     * composed engine's.
     *
     * The engine case is the normal shape of composition, not an edge: a
     * vertical that drives an engine emits about the thing the engine owns. A
     * production vertical's `contract/checklist-toggle` emits about `protocol`,
     * which belongs to engine-protocol — and could not be declared until
     * `defineOperations` learned the engines.
     *
     * Inlined rather than via an alias: TypeScript prints an alias unresolved,
     * so the diagnostic would name it instead of listing the entities (#705).
     *
     * Pointable only. An event is ABOUT one entity and `entityIdFrom` names the
     * one output field carrying its id — so a composite-keyed table cannot be an
     * event subject. Accepting it would have made the event about a third of a
     * row, which is the #695 defect with a different cause.
     */
    readonly entity:
      | ({
          readonly [K in keyof Entities]: Entities[K] extends {
            primaryKey: readonly [unknown, unknown, ...unknown[]];
          }
            ? never
            : K;
        }[keyof Entities] &
          string)
      | (Engines extends readonly (infer R)[]
          ? R extends Record<string, EntityDef>
            ? {
                readonly [K in keyof R]: R[K] extends { primaryKey: readonly [unknown, unknown, ...unknown[]] }
                  ? never
                  : K;
              }[keyof R] &
                string
            : never
          : never);
    /**
     * Which OUTPUT field carries that entity's id.
     *
     * The #695 defect: 18 operations emitted `entityId: String(result.id)` on
     * objects that answer with `contractId` / `runId` / `instanceId`. For a
     * mutation writing a child the event is about the PARENT, so the two differ
     * and nothing downstream would ever have flagged it.
     */
    readonly entityIdFrom: OutputKeys<O>;
    readonly type: string;
    readonly schemaVersion: number;
    /**
     * Fat payload, drawn from the output — minus anything the entity marks
     * `erasable`. Immutable events are the one place in a scope an erasure
     * cannot reach.
     */
    readonly payload?: readonly Exclude<OutputKeys<O>, ErasableOf<Entities, Engines, O>>[];
  } & PiiShape<O, OutputKeys<O>>;
  /**
   * Per-field permission on the projection: omission, not denial. The caller
   * still gets the row, without the fields they may not see.
   */
  readonly gates?: { readonly [F in OutputKeys<O>]?: PermKey };
} & OpAuthority<O, Entities, Engines, PermKey>;

// ---------------------------------------------------------------------------
// The composer.
// ---------------------------------------------------------------------------

/**
 * Declare a module's operations against its entities and permission keys.
 *
 * Curried so the entities and permissions are given explicitly while each
 * operation still infers its own input and output — a callback parameter cannot
 * be contextually typed by a generic being inferred from the object containing
 * it.
 *
 * ```ts
 * export const ops = defineOperations(calloutEntities, PERMISSIONS)({
 *   'customer/create': {
 *     summary: 'Register a customer',
 *     permission: 'customer:manage',
 *     input: z.object({ name: z.string() }),
 *     output: z.object({ id: z.string(), number: z.string() }),
 *     http: { method: 'POST', path: '/customers' },
 *     emits: {
 *       entity: 'customer', entityIdFrom: 'id',
 *       type: 'callout.customer-created', schemaVersion: 1, piiClass: 'none',
 *     },
 *   },
 * });
 * ```
 */
export function defineOperations<
  const Entities extends Record<string, EntityDef>,
  const Perms extends readonly string[],
  const Engines extends readonly Record<string, EntityDef>[] = [],
>(_entities: Entities, _permissions: Perms, _engines?: Engines) {
  return <
    const Ops extends {
      readonly [K in keyof Ops]: OperationShape<Ops[K], Entities, Engines, Perms[number]>;
    },
  >(
    operations: Ops,
  ): Ops => {
    assertListsArePaged(operations);
    return operations;
  };
}

/**
 * A read that answers with a whole table must say it is a page (#811).
 *
 * An unbounded list endpoint is a bug with a delay on it: it passes review, it
 * passes tests, and then one tenant's table gets large. So a bare `z.array(...)`
 * output with no `paged` beside it is refused — the operation either pages, or it
 * is not a list.
 *
 * ## Why at module load rather than in a lint tool
 *
 * #811 asked for this as a `lint:model --check` gate. A tool has to FIND the
 * declarations, and the ones it would have missed are exactly the ones that
 * matter: `model-diff` reads entities, not operations, and `api-diff` only sees
 * verticals that opted into `src/api.ts` — which is none of the four engines whose
 * list reads this issue was filed about. Checking here reaches every module that
 * declares operations at all, engine or vertical, with nothing to discover and
 * nothing to opt into.
 *
 * Same reasoning that moved #844's "a state the field cannot hold" check to load
 * time: it runs where it can actually bite. It fires in every build, every test
 * and every dev server, so it cannot be true only of the modules a tool knew about.
 *
 * **A nested array is untouched.** `output: z.object({ ids: z.array(…) })` is an
 * object with a list inside it — a shape whose size the operation controls — not a
 * table read. Only a TOP-LEVEL array output is a list by this rule.
 */
function assertListsArePaged(operations: Record<string, unknown>): void {
  for (const [name, op] of Object.entries(operations)) {
    const decl = op as { output?: unknown; paged?: unknown };
    if (decl.paged !== undefined) continue;
    if (!(decl.output instanceof z.ZodArray)) continue;
    throw new Error(
      `model: '${name}' returns a bare array and does not declare \`paged\` — a list read ` +
        'that answers with the whole table is unbounded by construction.\n' +
        '  Remedy: declare the ENTRY as `output` and add `paged`. Either the kernel ' +
        'composes the walk —\n' +
        "    paged: { over: { entity: 'thing', sortable: ['created_at'], filterable: ['status'] } }\n" +
        '  — or, where it cannot (a kernel table, a correlated subquery, a per-row ' +
        'permission walk),\n' +
        '  the handler composes its own and names the entry field the cursor walks:\n' +
        "    paged: { sortKey: 'article' }",
    );
  }
}

/**
 * The permission keys an operation set actually requires, for the manifest.
 *
 * Read structurally rather than through a `{ permission?: string }` parameter:
 * a `narrows` operation has neither `permission` nor `emits`, and TypeScript's
 * weak-type rule rejects an object sharing no properties with the parameter.
 */
export function permissionsUsedBy(operations: Readonly<Record<string, object>>): string[] {
  const keys = Object.values(operations).flatMap((op) => {
    const permission = (op as { permission?: unknown }).permission;
    if (typeof permission === 'string') return [permission];
    // An entity-narrowed check carries the key in `.key`; it is no less part of
    // this module's permission surface for being narrowed.
    if (permission && typeof permission === 'object') {
      const key = (permission as { key?: unknown }).key;
      if (typeof key === 'string') return [key];
    }
    // A proof walk checks per entity rather than up front, but the keys it
    // evaluates are just as much part of this module's permission surface.
    const checks = (op as { narrows?: { checks?: unknown } }).narrows?.checks;
    return Array.isArray(checks) ? checks.filter((k): k is string => typeof k === 'string') : [];
  });
  return [...new Set(keys)].sort();
}

/** The event types an operation set emits, for `manifest.events.emits`. */
export function eventsEmittedBy(
  operations: Readonly<Record<string, object>>,
): { type: string; schemaVersion: number }[] {
  const seen = new Map<string, number>();
  for (const op of Object.values(operations)) {
    const emits = (op as { emits?: { type?: unknown; schemaVersion?: unknown } }).emits;
    if (typeof emits?.type === 'string' && typeof emits.schemaVersion === 'number') {
      seen.set(emits.type, emits.schemaVersion);
    }
  }
  return [...seen.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, schemaVersion]) => ({ type, schemaVersion }));
}

/**
 * The paged lists an operation set declares, for the manifest (#811).
 *
 * Read off every `paged.over` the way `eventsEmittedBy` reads every `emits`, and
 * for the identical reason: the index the kernel provisions and the columns the
 * operation offers are ONE fact, and a manifest restating it by hand is how two
 * descriptions come to disagree. `table` and `idColumn` are resolved here from
 * the same registry the columns are compile-checked against, so nothing states
 * twice where a work order lives.
 *
 * **Two operations may page the same entity** — `workorder/list` and a vertical's
 * portal read over the same table — so their vocabularies are UNIONED rather than
 * refused. The index has to cover both walks either way, and one of them being
 * narrower is not a conflict. (Two *modules* claiming one entity type IS refused;
 * that check belongs to the kernel, which is the only thing that sees them all.)
 */
export function listsDeclaredBy(
  operations: Readonly<Record<string, object>>,
  entities: Record<string, EntityDef>,
  engines: readonly Record<string, EntityDef>[] = [],
): {
  entityType: string;
  sortable: string[];
  filterable?: string[];
  table: string;
  idColumn: string;
}[] {
  const byEntity = new Map<string, { sortable: string[]; filterable: string[] }>();
  for (const [name, op] of Object.entries(operations)) {
    const over = (op as { paged?: { over?: unknown } }).paged?.over as
      | { entity?: unknown; sortable?: unknown; filterable?: unknown }
      | undefined;
    if (!over || typeof over.entity !== 'string') continue;
    const acc = byEntity.get(over.entity) ?? { sortable: [], filterable: [] };
    for (const c of (over.sortable ?? []) as unknown[]) {
      if (typeof c === 'string' && !acc.sortable.includes(c)) acc.sortable.push(c);
    }
    for (const c of (over.filterable ?? []) as unknown[]) {
      if (typeof c === 'string' && !acc.filterable.includes(c)) acc.filterable.push(c);
    }
    if (!acc.sortable.length) {
      throw new Error(`model: '${name}' declares \`paged.over\` with no sortable column`);
    }
    byEntity.set(over.entity, acc);
  }
  return [...byEntity.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([entityType, acc]) => {
      const entity = entities[entityType] ?? engines.map((r) => r[entityType]).find(Boolean);
      if (!entity) {
        throw new Error(
          `model: a paged list is declared over '${entityType}', which is not a declared entity`,
        );
      }
      const key = primaryKeyOf(entityType, entity);
      if (key.length !== 1) {
        throw new Error(
          `model: '${entityType}' is keyed by (${key.join(', ')}) and cannot be paged — ` +
            'a keyset walk needs one column to break ties on, and a composite key has none',
        );
      }
      return {
        entityType,
        // NOT sorted: the first sortable column is the DEFAULT sort, so the order
        // of this array is part of the fact.
        sortable: acc.sortable,
        ...(acc.filterable.length ? { filterable: [...acc.filterable].sort() } : {}),
        table: entity.table,
        idColumn: key[0] as string,
      };
    });
}

/**
 * The handler map a declared operation set requires — CRM-EFF's `satisfies Impl`
 * seam, which is what makes the declaration BINDING rather than decorative.
 *
 * ```ts
 * export const operations = { … } satisfies OperationImpl<typeof calloutOps, OperationContext>;
 * ```
 *
 * Four things become compile errors at the exact method: a handler whose input
 * disagrees with the declared `input`, one whose return disagrees with the
 * declared `output`, an operation declared and not implemented, and one
 * implemented and not declared.
 *
 * `Ctx` is a parameter rather than `OperationContext` because contracts is below
 * the kernel and must not import it. The vertical supplies it.
 */
export type OperationImpl<Ops, Ctx> = {
  [K in keyof Ops]: Ops[K] extends { output: infer O }
    ? O extends z.ZodType
      ? (
          ctx: Ctx,
          input: ImplInput<Ops[K]>,
        ) => HandlerOutput<Ops[K]> | Promise<HandlerOutput<Ops[K]>>
      : never
    : never;
};

/**
 * What the PLATFORM adds to a paged read's input (#811).
 *
 * Not declared per operation, and that is the fix: every paged read used to
 * restate `limit` and `cursor` in its own `input` schema, which made the default
 * and the `LIST_PAGE_MAX` ceiling true of the reads whose author remembered them
 * rather than of the surface. `mountOperations` now parses the trio with the one
 * shared schema and merges it in, so a declaration cannot ship an uncapped page.
 *
 * Every field is OPTIONAL, including `limit`, and that is a correction rather
 * than a convenience: the host defaults the trio for an HTTP call, but an
 * in-process caller — a test, a seed, another operation, an MCP tool — invokes
 * with no page at all, and typing `limit` as always-present made a handler's
 * `input.limit` a lie that only showed up as a crash at runtime. `listLimitOf`
 * resolves it, and `ctx.page` applies it, so the answer is the same either way.
 */
export interface PagedInput {
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
  /** One of the declared `sortable` columns; unset means the first. */
  sort?: string;
}

/**
 * No declared `input` means the handler takes `undefined` — unless it is paged,
 * in which case the platform hands it the page trio whether it declared one or not.
 */
type ImplInput<O> = O extends { paged: unknown }
  ? (O extends { input: infer I }
      ? I extends z.ZodType
        ? O extends { inputOptional: true }
          ? Partial<z.infer<I>>
          : z.infer<I>
        : unknown
      : unknown) &
      PagedInput
  : O extends { input: infer I }
    ? I extends z.ZodType
      ? O extends { inputOptional: true }
        ? z.infer<I> | undefined
        : z.infer<I>
      : undefined
    : undefined;

// ---------------------------------------------------------------------------
// The manifest fragment the operations contribute.
// ---------------------------------------------------------------------------

/** Every permission key some operation declares, as a type. */
export type PermissionsDeclaredBy<Ops> = {
  [K in keyof Ops]: Ops[K] extends { permission: infer P } ? (P extends string ? P : never) : never;
}[keyof Ops];

/**
 * The operation half of a module's manifest — derived, not written twice.
 *
 * `manifestEntities` already derives the entity-shaped fragments from the
 * registry; this is its counterpart for the operation surface. Together they
 * leave the hand-written manifest holding only what is genuinely a fact about
 * *this deployment* rather than about the app: id, version, migrations dir,
 * entitlement, env spec.
 *
 * ```ts
 * export const manifest = moduleManifest.parse({
 *   id: '@acme/vertical', version: '0.1.0', kernelContract: '^0.0.1',
 *   migrations: { journalDir: './migrations', compatibleFrom: '0.1.0' },
 *   ...manifestOperations(operations, {
 *     permissions: { 'list:manage': 'Own and manage your lists' },
 *   }),
 *   ...manifestEntities(entities, {}),
 * });
 * ```
 *
 * **Descriptions are supplied, keys are derived.** The prose feeds the human
 * permission diff and belongs beside the manifest; the key SET is a fact about
 * what the operations check, and deriving it is what stops the two disagreeing.
 * A key some operation checks but nobody described is an error rather than a
 * silently undocumented permission.
 *
 * Extra descriptions are allowed on purpose: a `narrows` operation walks with a
 * permission the model does not name (it declares only the reason), so a key
 * reached solely by a proof walk has to be declarable here or it would vanish
 * from the review artifact.
 */
export function manifestOperations<const Ops extends Record<string, object>>(
  operations: Ops,
  spec: {
    readonly permissions: Readonly<Record<PermissionsDeclaredBy<Ops>, string>> & Readonly<Record<string, string>>;
    /** Event types this module consumes — not derivable from its own operations. */
    readonly consumes?: readonly { readonly type: string; readonly schemaVersion: number }[];
  },
): {
  permissions: { key: string; description: string }[];
  events: {
    emits: { type: string; schemaVersion: number }[];
    consumes: { type: string; schemaVersion: number }[];
  };
} {
  const described = spec.permissions as Record<string, string>;
  const used = permissionsUsedBy(operations);

  const undescribed = used.filter((key) => !described[key]);
  if (undescribed.length > 0) {
    throw new Error(
      `manifestOperations: no description for permission(s) ${undescribed.join(', ')} — ` +
        'every key an operation checks appears in the permission review, so it needs prose',
    );
  }

  return {
    permissions: Object.keys(described)
      .sort()
      .map((key) => ({ key, description: described[key] as string })),
    events: {
      emits: eventsEmittedBy(operations),
      consumes: [...(spec.consumes ?? [])].sort((a, b) => a.type.localeCompare(b.type)),
    },
  };
}

// ---------------------------------------------------------------------------
// Binding a composed engine's operations to this vertical's URLs.
// ---------------------------------------------------------------------------

/**
 * Where one composed-engine operation lives in THIS vertical's HTTP surface.
 *
 * `{var}` is checked against the ENGINE's own declared input, so a path naming a
 * field the engine does not accept is a compile error.
 */
type EngineRouteBinding<Op, B> = {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  // Self-referential in the binding, so the LITERAL path flows into the check.
  // Written `PathAgainst<Op, string>` the constraint compiles clean and enforces
  // nothing: `PathParams<string>` is `never`, which vacuously satisfies any
  // input — the exact shape of a decorative type-level check.
  readonly path: B extends { readonly path: infer P } ? PathAgainst<Op, P> : never;
};

/** Every `{var}` in the path must name a field of the engine operation's input. */
type PathAgainst<Op, P> = P extends string
  ? [PathParams<P>] extends [InputKeys<Op>]
    ? P
    : never
  : never;

/**
 * Declare where a composed engine's operations live in this vertical's API.
 *
 * An engine declares no `http`, and should not: it is entity-agnostic and does
 * not own a URL shape — a bike shop calls the same work order a repair, and both
 * are right. The path is the vertical's decision, and this is where it gets
 * declared instead of buried in a hand-written route table (Callout: 17 of 27
 * routes).
 *
 * ```ts
 * export const engineRoutes = defineEngineRoutes(workorderOperations)({
 *   'workorder/get': { method: 'GET', path: '/workorders/{orderId}' },
 * });
 * ```
 *
 * Curried, so the engine's operations are given explicitly while each binding is
 * still checked against its own operation. The result MERGES the engine's
 * declaration with the path, so `mountOperations` and `apiCatalogFrom` read it
 * exactly as they read a vertical's own operations — the engine's real input and
 * output schemas reach the router and the API document, rather than a
 * restatement the vertical had to write.
 *
 * A `{var}` naming a field the engine's input does not accept is a compile
 * error. An operation the engine does not have throws when the module loads —
 * see the note in the body for why that one is not a type error.
 */
export function defineEngineRoutes<const Ops extends Record<string, object>>(operations: Ops) {
  return <const R extends { readonly [K in keyof R]: K extends keyof Ops ? EngineRouteBinding<Ops[K], R[K]> : never }>(
    routes: R,
  ): { [K in keyof R]: (K extends keyof Ops ? Ops[K] : never) & { http: R[K] } } => {
    const out: Record<string, unknown> = {};
    for (const [name, http] of Object.entries(routes)) {
      const op = operations[name as keyof Ops];
      // Checked HERE rather than by the type. The constraint is self-referential
      // in `R`, and inference degrades: an unknown key resolves to `never` in
      // the constraint and TypeScript accepts it anyway. A constraint that reads
      // like a check and enforces nothing is worse than no constraint, so this
      // is not claimed at the type level — it throws when the module loads,
      // which is still long before anything serves a request.
      if (!op) {
        throw new Error(
          `defineEngineRoutes: '${name}' is not an operation of this engine — it declares ` +
            `${Object.keys(operations).sort().join(', ')}`,
        );
      }
      out[name] = { ...(op as object), http };
    }
    return out as { [K in keyof R]: (K extends keyof Ops ? Ops[K] : never) & { http: R[K] } };
  };
}

/**
 * The input and output a HANDLER must have, derived from its declaration.
 *
 * These exist so a vertical writes the `satisfies` clause once against the model
 * instead of restating how a declaration maps to a handler signature — and, more to
 * the point, so `paged` is understood in ONE place. A paged read declares its ENTRY
 * shape and returns a `Page` of it; deriving that in each vertical's module file
 * would mean each vertical could get it wrong, and one that did would typecheck
 * against an envelope it never returns.
 *
 * `OperationHandler` itself stays in the kernel (contracts cannot import it, and does
 * not need to) — these describe only the two type arguments.
 *
 * ```ts
 * } satisfies {
 *   [K in keyof typeof todoOperations]: OperationHandler<
 *     HandlerInput<(typeof todoOperations)[K]>,
 *     HandlerOutput<(typeof todoOperations)[K]>
 *   >;
 * };
 * ```
 */
export type HandlerInput<O> = ImplInput<O>;

export type HandlerOutput<O> = O extends { output: infer R }
  ? R extends z.ZodType
    ? O extends { paged: { total: true } }
      ? CountedPage<z.infer<R>>
      : O extends { paged: unknown }
        ? Page<z.infer<R>>
        : z.infer<R>
    : unknown
  : unknown;
