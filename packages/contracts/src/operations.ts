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
 * `input` is a real Zod object, not a description of one. That is the whole
 * reason the model is TypeScript (#680): a schema language would need the shape
 * written twice, and transcription is what produced 40 wrong argument names in
 * the one app where this was measured.
 *
 * Being real is also what lets the HOST parse with it (#893) — the declaration
 * is the thing that refuses a malformed call, rather than a description of a
 * refusal each handler was trusted to implement.
 */
import { LIST_PAGE_MAX, type CountedPage, type Page } from './pagination.js';
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
 *
 * An engine narrowing to a ref the caller owns says `refFrom` and names the field
 * carrying it whole (#896) — see `PermissionRefCheck` below.
 *
 * An operation that narrows to more than one type says `entityFrom` in place of
 * `entity`, naming the input field that carries the type (#890). The admissible
 * types come from that field's own schema — `z.enum(['workorder', 'protocol'])` —
 * so the set is stated once and cannot drift from a second list. `entity` remains
 * the right answer wherever there is one type, and an open `z.string()` behind
 * `entityFrom` remains undrivable by the conformance kit, which reports it rather
 * than picking a type.
 */
type PermissionCheck<O, Entities, Engines, PermKey extends string> = {
  readonly key: PermKey;
} & (
  | {
      /**
       * The entity type the check narrows to — this module's, or a composed
       * engine's.
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
                  readonly [K in keyof R]: R[K] extends {
                    primaryKey: readonly [unknown, unknown, ...unknown[]];
                  }
                    ? never
                    : K;
                }[keyof R] &
                  string
              : never
            : never);
      readonly entityFrom?: never;
    }
  | {
      /**
       * The input field carrying the entity TYPE, when one operation narrows to
       * more than one (#890).
       *
       * Both timelines are this shape: `callout/timeline` reads the spine of a
       * work order for the app and of a protocol for the signing beat, checking
       * `workorder:read` on whichever the caller names. Declaring `entity:
       * 'workorder'` was true of most callers and narrower than the operation,
       * and the artifact being narrower than the code is still the artifact
       * being wrong.
       *
       * The admissible types are NOT listed here. They are read off the schema at
       * this field, so the model states them once — `z.enum(['workorder',
       * 'protocol'])` — and a list that could go stale never exists. Leave that
       * field an open `z.string()` and the conformance kit reports the operation
       * as uncovered rather than guessing a type to drive.
       *
       * This is the bounded answer, not "any entity at all": an unbounded type
       * field is what makes an operation unsafe to bind to a URL, and it stays
       * unsafe. What changed is that the declaration can now say which few types
       * it means.
       */
      readonly entityFrom: InputKeys<O>;
      readonly entity?: never;
    }
) & (
  | { readonly idFrom: InputKeys<O>; readonly resolved?: never }
  | { readonly resolved: string; readonly idFrom?: never }
);

/**
 * A check narrowed to a ref the caller supplies WHOLE — type and id together
 * (#896).
 *
 * This is the engine case, and it is not the same shape as `entityFrom`.
 * `entityFrom` still ends at a type someone declared: the field names it, the
 * schema bounds it, and the kit creates one. An engine composed by a vertical
 * narrows to a noun that is in NO registry it can see — `engines/absence` checks
 * `absence:read` against `input.subject`, and the subject is Meridian's
 * `employee`, which absence cannot name and by design does not know:
 *
 * > It knows NOTHING about who a subject is (the vertical owns the directory).
 *
 * So the declaration stops trying to name the type and names the FIELD carrying
 * the ref instead. One field, both halves: an `EntityRef` is `{ entityType,
 * entityId }`, so there is nothing left for `entity` or `idFrom` to add, and
 * declaring either alongside is a compile error rather than a second opinion.
 *
 * What is still stated — and it is the thing that matters — is *this is not a
 * node check*. That is the whole distinction #736 was filed about, and the one an
 * engine most needs to make: a handler that checked `absence:read` at the node
 * would let anyone holding the key anywhere in the scope read anyone's ledger,
 * with every test green.
 *
 * The conformance kit drives these: it creates an entity of a type its own
 * FIXTURE names, grants the key narrowed to that ref, and requires the handler to
 * honour it — which is exactly the check, since the engine is supposed to accept
 * whatever noun it is handed.
 */
type PermissionRefCheck<O, PermKey extends string> = {
  readonly key: PermKey;
  /**
   * The input field holding the whole `EntityRef`.
   *
   * A dotted path reaches one level in, for a ref that arrives inside a larger
   * object — absence's `request` takes `subject: { ref, dataSubjectId }`, where
   * the erasure key travels beside the ref and only the ref is checked. The first
   * segment is held to the input's own fields; the second cannot be, and a path
   * that does not resolve is reported by the kit rather than driven.
   */
  readonly refFrom: InputKeys<O> | `${InputKeys<O> & string}.${string}`;
  readonly entity?: never;
  readonly entityFrom?: never;
  readonly idFrom?: never;
  readonly resolved?: never;
};

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
      readonly permission:
        | PermKey
        | PermissionCheck<O, Entities, Engines, PermKey>
        | PermissionRefCheck<O, PermKey>;
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
 * Optimistic concurrency over one entity (#129).
 *
 * Present means the caller's `If-Match` is compared against the entity's version
 * INSIDE the operation's transaction, before the guards and before any engine
 * call, and a mismatch raises `precondition_failed` (412). The response carries
 * the entity's version as an `ETag` either way, so a read hands the client the
 * token its next write will send.
 *
 * ```ts
 * 'acme/update-customer': {
 *   input: z.object({ customerId: z.string(), name: z.string().optional() }),
 *   concurrency: { over: 'customer', idFrom: 'customerId' },
 *   emits: { entity: 'customer', entityIdFrom: 'id', … },
 * }
 * ```
 *
 * ## Why this is declared rather than blanket
 *
 * #129 originally asked that every write require `If-Match`. That was reasoned
 * from a premise the model has since falsified — *"routes are hand-written thin
 * over engine in-scope functions"* — and the operations the model actually
 * produced are command-shaped, not resource-shaped. Two concurrent
 * `todo/rename-list` calls do not lose an update: the second caller sent a name,
 * not a whole entity it read and echoed back. A mandatory precondition there is a
 * forced GET round-trip guarding nothing, on every write in the fleet.
 *
 * The shape that DOES lose updates is the field-bag PATCH, and it is not left to
 * an author's memory: `assertFieldBagsDeclareConcurrency` refuses one that omits
 * this.
 *
 * ## `over` is the entity the operation EMITS about, and that is checked
 *
 * A version is the ULID of the last event about the entity, so an operation that
 * guards an entity it does not announce a change to is not merely unprotected —
 * it is WORSE than unprotected. Both writers pass their `If-Match`, neither moves
 * the version, both commit, and the 200s carry an `ETag` asserting the write was
 * serialised. `assertConcurrencyMovesVersion` refuses that at module load; see
 * `entity-version.ts`, which asks for this check by name.
 */
export type ConcurrencyShape<O, Entities, Engines> = {
  /**
   * The entity whose version the precondition compares — this module's, or a
   * composed engine's.
   *
   * Pointable only, for the reason every other narrowed position is: a version is
   * read for ONE entity id, and `idFrom` names the single input field carrying it,
   * so a composite-keyed table has nothing to point at. Inlined rather than
   * aliased, per `PointableName` in `model.ts`.
   */
  readonly over:
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
              readonly [K in keyof R]: R[K] extends {
                primaryKey: readonly [unknown, unknown, ...unknown[]];
              }
                ? never
                : K;
            }[keyof R] &
              string
          : never
        : never);
  /**
   * The input field carrying that entity's id — the same compile-checked join as
   * `permission.idFrom`, and load-bearing for the same reason: a precondition read
   * against the wrong row admits every stale write while looking like it works.
   */
  readonly idFrom: InputKeys<O>;
};

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
   * The request body — the schema the HOST parses this operation's input with.
   *
   * **The handler does not have to parse it, and should not need to.** A module
   * hands its derived schemas over as `operationInputs` (see
   * `operationInputsOf`), and the scope host parses every invocation against
   * them before the guards and the handler run — over HTTP, from a test, from a
   * seed, from a schedule. So a handler's declared input type is a fact about
   * what it receives rather than a claim about what it was sent.
   *
   * This used to read *"the SAME Zod object the handler parses"*, and across the
   * fleet it mostly was not: of ~85 declared inputs, 40 were parsed, and
   * `demos/rally` declared 32 and parsed 2 (#893). The declaration was true
   * about the shape and false about the parsing.
   *
   * **Omitted means no body at all**, and the handler then takes `undefined`.
   * Found by the first adopter: three of Callout's six operations take no input,
   * and a required `z.object({})` cannot say so — a handler accepting only
   * `undefined` is not assignable to one accepting `{}`. A paged operation is
   * the exception in both directions: the platform supplies its page whether one
   * was declared or not, and materialises an empty one for an in-process caller
   * that passes nothing.
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
  /**
   * This operation participates in optimistic concurrency (#129).
   *
   * One declaration, two consequences that follow from HTTP's own method
   * semantics rather than from a second flag: the response always carries an
   * `ETag`, and an UNSAFE method (POST/PUT/PATCH/DELETE) additionally honours
   * `If-Match` and refuses a stale one with 412. So the same line on a read hands
   * out the token, and on a write requires it back.
   *
   * See `ConcurrencyShape` for why `over` must be the entity the operation emits
   * about, and why this is opt-in rather than blanket.
   */
  readonly concurrency?: ConcurrencyShape<O, Entities, Engines>;
  /**
   * Opt OUT of request idempotency (#116). Only `false` is a legal value.
   *
   * Every operation on an unsafe method honours `Idempotency-Key` by default,
   * because a retried write creating a second entity is a hazard on all of them —
   * unlike a lost update, which is a hazard on the field-bag shape alone and is
   * why `concurrency` above is opt-IN. The client opts in by sending the header;
   * the server never requires one.
   *
   * What honouring it costs, and therefore what this field is for: the response
   * is recorded in the scope database for `IDEMPOTENCY_RETENTION_MS` so that the
   * retry can be answered with it. An operation whose result must not be stored —
   * a freshly minted secret, a one-time token, a body carrying personal data the
   * erasure sweep would never find — says so here, and the host then REFUSES the
   * header rather than quietly storing the response or quietly executing twice.
   *
   * ```ts
   * 'acme/mint-token': {
   *   idempotency: false,   // the response is a credential; do not record it
   *   …
   * }
   * ```
   *
   * Opt-out rather than opt-in because the two read differently in a diff. A
   * missing opt-in is invisible — nobody reviews an absence — while `idempotency:
   * false` is a line someone wrote, and a reviewer can ask why. It is the same
   * reasoning `narrows` applies to a permission that is deliberately not
   * node-level: state the exception, never the rule.
   */
  readonly idempotency?: false;
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
>(entities: Entities, _permissions: Perms, engines?: Engines) {
  return <
    const Ops extends {
      readonly [K in keyof Ops]: OperationShape<Ops[K], Entities, Engines, Perms[number]>;
    },
  >(
    operations: Ops,
  ): Ops => {
    assertListsArePaged(operations);
    assertConcurrencyMovesVersion(operations);
    assertFieldBagsDeclareConcurrency(operations, entities, engines ?? []);
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
 * A guarded operation must ANNOUNCE the change it guards (#129).
 *
 * An entity's version is the ULID of the last event about it, so a `concurrency`
 * declaration over an entity the operation does not emit about is not a weaker
 * protection — it is an inverted one:
 *
 * 1. A and B both read the customer at version V and both send `If-Match: V`.
 * 2. A's write commits. It emits nothing about `customer`, so the version is still V.
 * 3. B's precondition compares V against V, passes, and overwrites A.
 * 4. Both callers received 200 and an `ETag`, which is the wire's way of saying
 *    the write was serialised against a known version.
 *
 * That is the original lost update, now with a mechanism asserting it did not
 * happen — strictly worse than no precondition, because it is believed. So the
 * join is checked rather than trusted, which is what `entity-version.ts` asks for
 * where it names the one hole in deriving a version from the spine:
 *
 * > a mutation that emits no event does not move the version … the answer is
 * > that a declared `concurrency` must be compile-checked against the operation's
 * > declared `emits` (#129), which is strictly more than a trigger would have
 * > given: a trigger guarantees the column moved, never that the operation
 * > announced what it did.
 *
 * ## Why a read is exempt
 *
 * An operation with no `emits` at all is a READ, and on a read this declaration
 * means "answer with an `ETag`" — there is nothing to serialise and nothing to
 * refuse. The rule therefore bites only where the operation emits and names a
 * DIFFERENT entity, plus the one case that cannot be read as a read: an unsafe
 * HTTP method with no event, which is a mutation that does not announce itself
 * and is already a rule violation without this.
 */
function assertConcurrencyMovesVersion(operations: Record<string, unknown>): void {
  for (const [name, op] of Object.entries(operations)) {
    const decl = op as {
      concurrency?: { over?: unknown };
      emits?: { entity?: unknown };
      http?: { method?: unknown };
    };
    const over = decl.concurrency?.over;
    if (typeof over !== 'string') continue;
    const emitted = decl.emits?.entity;
    if (emitted === over) continue;
    const method = decl.http?.method;
    const unsafe = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    if (emitted === undefined && !unsafe) continue; // a read: the ETag half only
    throw new Error(
      `model: '${name}' declares \`concurrency.over: '${over}'\` but ` +
        (emitted === undefined
          ? `emits no event, and it is served as ${String(method)} — a mutation that ` +
            'announces nothing does not move a version'
          : `emits about '${String(emitted)}'`) +
        '.\n' +
        `  An entity's version IS the last event about it, so nothing this operation ` +
        `does moves '${over}'. Two callers holding the same tag would both pass the ` +
        'precondition and both commit — the lost update this declaration exists to ' +
        'refuse, with a 200 and an `ETag` asserting it did not happen.\n' +
        `  Remedy: emit about '${over}' (\`emits: { entity: '${over}', … }\`), or guard ` +
        'the entity this operation actually announces.',
    );
  }
}

/**
 * A read-modify-write shape must say how it serialises (#129).
 *
 * `concurrency` is opt-in because most declared operations are command-shaped and
 * genuinely do not need it (see `ConcurrencyShape`). But "remember to opt in on
 * the dangerous ones" is not a guarantee, and the dangerous ones have a shape the
 * model can already see: a single required field naming the row, and every other
 * field OPTIONAL over that entity's own columns. That is read-modify-write by
 * construction — the caller GET the entity, changed a field, and sent the bag
 * back — and it is the one shape where a concurrent writer's change is silently
 * destroyed rather than merely re-ordered.
 *
 * This is the `paged`-vs-bare-array refusal applied to a second defect class, and
 * it is deliberately being added while it matches NOTHING in the fleet: zero
 * operations means zero migration, which makes now the cheapest moment it will
 * ever be. Waiting until the shape appears means waiting until it appears
 * unguarded.
 *
 * ## Why the test is this narrow
 *
 * A rule that refuses correct code trains people to route around it, so every
 * clause here exists to exclude something legitimate:
 *
 * - **Two or more optional fields.** One optional field is a nullable
 *   command (`{ orderId, note? }`), not a bag.
 * - **Exactly one required field.** `shop/set-stock` takes `{ productId,
 *   quantity }` — two required fields, a command that states its whole intent.
 * - **Every optional field is a column of that entity.** A filter, a flag, or a
 *   reason code alongside the update is not the entity being echoed back.
 *
 * Column names are snake_case and input fields are camelCase, so the comparison
 * crosses that seam explicitly rather than accidentally matching nothing.
 */
function assertFieldBagsDeclareConcurrency(
  operations: Record<string, unknown>,
  entities: Record<string, EntityDef>,
  engines: readonly Record<string, EntityDef>[],
): void {
  for (const [name, op] of Object.entries(operations)) {
    const decl = op as {
      concurrency?: unknown;
      emits?: { entity?: unknown };
      permission?: { entity?: unknown };
      input?: z.ZodObject<z.ZodRawShape>;
    };
    if (decl.concurrency !== undefined) continue;
    // The entity the operation is ABOUT. `emits` is the reliable statement; a
    // narrowed permission is the fallback, and it is what catches the write that
    // does not emit — which would otherwise escape by breaking a second rule.
    const about = decl.emits?.entity ?? decl.permission?.entity;
    if (typeof about !== 'string') continue;
    const entity = entities[about] ?? engines.map((r) => r[about]).find(Boolean);
    if (!entity) continue;
    const shape = decl.input?.shape;
    if (!shape) continue;

    const required: string[] = [];
    const optional: string[] = [];
    for (const [field, schema] of Object.entries(shape)) {
      (isOptionalSchema(schema) ? optional : required).push(field);
    }
    if (required.length !== 1 || optional.length < 2) continue;

    const columns = new Set(Object.keys(entity.fields.shape));
    if (!optional.every((field) => columns.has(snakeCaseField(field)))) continue;

    const emits = typeof decl.emits?.entity === 'string';
    throw new Error(
      `model: '${name}' takes a partial field-bag over '${about}' — ` +
        `\`${required[0]}\` names the row and ${optional.map((f) => `\`${f}\``).join(', ')} ` +
        'are its own columns, every one optional — and declares no `concurrency`.\n' +
        '  That is read-modify-write: two callers who both read the row, each change ' +
        'one field and each save, do not conflict. The second write silently destroys ' +
        'the first, and nothing surfaces it.\n' +
        `  Remedy: \`concurrency: { over: '${about}', idFrom: '${required[0]}' }\`` +
        (emits
          ? '.'
          : `, and emit about '${about}' — a version is the last event about an entity, ` +
            'so a write that announces nothing cannot be guarded.'),
    );
  }
}

/** `customerId` → `customer_id`: input fields and columns sit either side of this seam. */
function snakeCaseField(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Is this declared field one the caller may omit?
 *
 * Read structurally, for the reason every other Zod read in the repo is: two
 * copies of the library in one build make `instanceof` a coin toss. Looks through
 * the wrappers that do not change optionality's answer, and treats a `default` as
 * optional — a field the caller can leave out is a field the caller can leave out,
 * however the gap is filled.
 */
function isOptionalSchema(schema: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  const def = (schema as { _zod?: { def?: unknown } })?._zod?.def as { type?: string; innerType?: unknown } | undefined;
  switch (def?.type) {
    case 'optional':
    case 'nullish':
    case 'default':
    case 'prefault':
      return true;
    case 'readonly':
    case 'nullable':
      return isOptionalSchema(def.innerType, depth + 1);
    default:
      return false;
  }
}

/**
 * The concurrency each operation declares, for the host (#129).
 *
 * Handed over beside `operationInputs` and read the same way — the adapter
 * compares versions from this map rather than each handler being trusted to. Same
 * argument as the parse: one place that cannot be forgotten beats a rule every
 * new operation has to remember.
 */
export function operationConcurrencyOf(
  operations: Readonly<Record<string, object>>,
): Record<string, { entity: string; idFrom: string }> {
  const out: Record<string, { entity: string; idFrom: string }> = {};
  for (const [name, op] of Object.entries(operations)) {
    const decl = (op as { concurrency?: { over?: unknown; idFrom?: unknown } }).concurrency;
    if (typeof decl?.over !== 'string' || typeof decl.idFrom !== 'string') continue;
    out[name] = { entity: decl.over, idFrom: decl.idFrom };
  }
  return out;
}

/**
 * The operations that opted OUT of request idempotency (#116).
 *
 * A set of names rather than a map, because there is nothing to configure: the
 * declaration is a refusal, and its only content is which operations made it.
 *
 * Read structurally, like every other extractor here — a module hands the host
 * its plain operations object and the host never sees the declaration's types.
 */
export function operationIdempotencyOptOutsOf(
  operations: Readonly<Record<string, object>>,
): string[] {
  return Object.entries(operations)
    .filter(([, op]) => (op as { idempotency?: unknown }).idempotency === false)
    .map(([name]) => name)
    .sort();
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
    /**
     * Keys these operations CHECK but another module DECLARES — each named with
     * the module that owns it.
     *
     * A vertical composing an engine is gated by the engine's keys, not only its
     * own: `callout/timeline` checks `workorder:read`, and the work order engine
     * is what declares that key, describes it, and owns its meaning. Without a
     * way to say so, such an operation had two bad options — restate the engine's
     * key in this manifest (two modules declaring one key, and the description
     * free to drift from the owner's) or name a key of its own that it does not
     * actually check. Callout took the second and declared `customer:manage` on
     * an operation enforcing `workorder:read`, which is how its permission
     * snapshot came to tell a technician they could not read a timeline they
     * could read every time (#865).
     *
     * Listed, never inferred. An unlisted key is still an error, so this cannot
     * swallow a typo; and an entry naming a key no operation checks is an error
     * too, because a stale exemption reads as coverage that is not there.
     */
    readonly checksDeclaredElsewhere?: Readonly<Record<string, string>>;
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
  const elsewhere = spec.checksDeclaredElsewhere ?? {};
  const used = permissionsUsedBy(operations);

  const undescribed = used.filter((key) => !described[key] && !elsewhere[key]);
  if (undescribed.length > 0) {
    throw new Error(
      `manifestOperations: no description for permission(s) ${undescribed.join(', ')} — ` +
        'every key an operation checks appears in the permission review, so it needs prose',
    );
  }

  // The exemption is only worth having if it stays true. A key listed here that
  // no operation checks is a note left behind by a change, and it would sit in
  // the source looking like an accounted-for engine dependency.
  const stale = Object.keys(elsewhere).filter((key) => !used.includes(key));
  if (stale.length > 0) {
    throw new Error(
      `manifestOperations: checksDeclaredElsewhere names permission(s) no operation checks: ` +
        `${stale.sort().join(', ')} — a stale exemption reads as a dependency that is still there`,
    );
  }

  // A key cannot be both this module's and someone else's.
  const both = Object.keys(elsewhere).filter((key) => described[key]);
  if (both.length > 0) {
    throw new Error(
      `manifestOperations: permission(s) ${both.sort().join(', ')} are described here AND ` +
        'declared elsewhere — one module owns a key, and its description belongs with it',
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
// The schemas the HOST parses an invocation against.
// ---------------------------------------------------------------------------

/**
 * What the PLATFORM merges into a paged read's input, as a schema (#811/#893).
 *
 * The mirror of `PagedInput` on the value side. `mountOperations` merges the
 * page trio into the payload AFTER the declaration has had its say, so a strict
 * parse against `input` alone would strip `limit`/`cursor`/`order`/`sort` back
 * out and hand every paged handler an unpaged request. Declared here once so
 * the two descriptions of the same four fields cannot drift.
 *
 * Every field is optional and none is defaulted: `listPageQuery` already
 * resolved the default and the ceiling at the wire, and an in-process caller
 * legitimately passes no page at all (`listLimitOf` is what answers then).
 * Re-defaulting here would make `limit` present for a caller who never sent it —
 * the exact lie `PagedInput` was corrected to stop telling.
 */
const pagedInputFields = {
  limit: z.number().int().positive().max(LIST_PAGE_MAX).optional(),
  cursor: z.string().min(1).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  sort: z.string().min(1).optional(),
} as const;

/**
 * name → the schema the host parses an invocation's input against (#893).
 *
 * ## Why this is derived rather than parsed in the handler
 *
 * `input` documents itself as *"the SAME Zod object the handler parses"*, and
 * across the fleet it mostly was not: of ~85 declared inputs, 40 were parsed.
 * Rally declared 32 and parsed 2. The declaration was true about the shape —
 * `idFrom` and `entityIdFrom` are held to it by the compiler — and false about
 * the parsing, which is the half that actually refuses a malformed call.
 *
 * A lint rule was the other candidate and is strictly weaker. It can only ask
 * whether *some* `.parse` appears in a handler body, not whether it is the
 * declared schema, at the boundary, before the first read of a field. And it is
 * unfulfillable where the schema is declared inline (`input: z.object({…})`) —
 * callout, handlebar and todo declare 25 inputs with no identifier a handler
 * could name, and the reference implementation is one of them.
 *
 * So the host parses instead, from the same declaration that already produces
 * the manifest, the routes and the OpenAPI document. `mountOperations` already
 * does exactly this for the page trio, and for the same stated reason: it is
 * what makes the ceiling *"true of every paged endpoint rather than of the ones
 * whose author remembered"*.
 *
 * ## What it means for a handler
 *
 * The input a handler receives is parsed, so unknown keys are gone and every
 * declared field has its declared type. A handler that parsed for itself may
 * keep doing so — the second parse is a no-op on an already-parsed value — but
 * it no longer has to, and a new operation cannot forget.
 *
 * An operation with no declared `input` is absent from the map: it takes
 * `undefined`, and `z.object({})` cannot say that (see `input` above). A paged
 * operation is always present even with no `input`, because the platform hands
 * it a page whether it declared one or not.
 */
export function operationInputsOf<const Ops extends Record<string, object>>(
  operations: Ops,
): Record<string, z.ZodType> {
  const inputs: Record<string, z.ZodType> = {};
  for (const [name, op] of Object.entries(operations)) {
    const decl = op as {
      input?: z.ZodObject<z.ZodRawShape>;
      inputOptional?: boolean;
      paged?: unknown;
    };
    if (decl.paged) {
      // `inputOptional` on a paged read means the FILTERS are optional, not the
      // body — the platform always supplies a page. `.partial()` is what
      // `ImplInput` says (`Partial<z.infer<I>> & PagedInput`), and saying it
      // twice is how the two would come to disagree.
      const filters = decl.input ?? z.object({});
      const shape = (decl.inputOptional ? filters.partial() : filters).extend(pagedInputFields);
      // A paged handler is never handed `undefined` — `ImplInput` types its
      // input as `… & PagedInput` with no undefined arm, because the PLATFORM
      // supplies the page "whether it declared one or not". Over HTTP that is
      // already true: `mountOperations` merges the trio into a payload that
      // therefore exists. In process it was not — `invoke('booking/list')` with
      // no argument is the ordinary way a test, a seed or another operation
      // reads a list, and the declaration promises that answers the same way.
      //
      // So the empty page is materialised here rather than each paged handler
      // learning to survive `undefined`. A required FILTER still fails, just
      // against `{}` and with a message naming the field.
      inputs[name] = z.preprocess((value) => value ?? {}, shape);
      continue;
    }
    if (!decl.input) continue;
    inputs[name] = decl.inputOptional ? decl.input.optional() : decl.input;
  }
  return inputs;
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
