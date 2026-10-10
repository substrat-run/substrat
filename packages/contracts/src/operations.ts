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
import { primaryKeyOf, type EmittedExport, type EntityDef, type EntityFields } from './model.js';

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
 * The `outsideText` fields of the entity this event is about — resolved exactly as
 * `ErasableOf` resolves, and refused in a payload for the same reason: an event outlives
 * whatever the module later does to the row.
 */
type OutsideTextOf<Entities, Engines, O> = O extends { emits: { entity: infer N } }
  ? N extends keyof Entities
    ? Entities[N] extends { outsideText: readonly (infer F)[] }
      ? F & string
      : never
    : Engines extends readonly (infer R)[]
      ? R extends Record<string, EntityDef>
        ? N extends keyof R
          ? R[N] extends { outsideText: readonly (infer F)[] }
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
 * both and never neither (rule 5 / the SDL adopter's check 14, #695). `narrows` is the
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

/**
 * What `trashed` may say on this operation: `'admits' | 'purges'` where the leading check is
 * `{ entity: E, idFrom }` and `E` declares `trash`, and nothing anywhere else.
 */
type TrashedShape<O, Entities> = O extends { permission: { entity: infer E; idFrom: infer F } }
  ? E extends keyof Entities
    ? Entities[E] extends { trash: object }
      ? 'admits' | (Exclude<InputKeys<O>, F> extends never ? 'purges' : never)
      : never
    : never
  : never;

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
        /**
         * This operation checks NOTHING — not here, not in a composed module.
         *
         * Needed because `checks: []` alone means two different things and the
         * conformance receipt counted both as a proof walk: Callout's portal walk
         * lists nothing because the key it walks (`workorder:read`) belongs to the
         * engine that declares it, while `invites/accept` lists nothing because the
         * recipient holds nothing yet and the invitation itself is the authority.
         * The first is a per-entity walk, the second is an ungated operation with a
         * stated reason — and a receipt reporting "1 per-entity proof walk" under a
         * header counting zero narrowed checks is the second one wearing the first
         * one's clothes.
         *
         * Deliberately opt-in: an operation that forgets the flag is reported as a
         * walk, which is the claim that gets scrutinised. The reason field is what
         * separates this from an oversight either way.
         */
        readonly unchecked?: true;
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
  /** A reasoned exception when a PATCH input cannot be an optional, default-free field bag. */
  readonly patchException?: string;
  /**
   * The PLATFORM writes this operation's handler (#1773) — see `DerivedKind` for the four shapes
   * and what each one does.
   *
   * A declaration whose shape the platform can derive says either this or `authored`, and
   * `defineOperations` refuses one that says neither: a hand-written `get` restates its
   * declaration, and each restatement drifts a little differently. `derive` on a shape that does
   * not match refuses too, naming the clause that fails. A derived operation takes no handler —
   * `operationsFor` leaves it out of the map it requires, and supplies it.
   */
  readonly derive?: DerivedKind;
  /**
   * Why this operation's handler is written by hand although the platform could derive it
   * (#1773). The reason is the review artifact: it names what the derived handler would get
   * wrong here — a parent-existence check, a projection, a child table. Refused on an operation
   * that is not derivable, where every handler is authored and the line would only be noise.
   */
  readonly authored?: string;
  /**
   * This operation's MCP rendering (#112) — the ONE knob, and it is optional.
   *
   * An operation that declares `http` is a tool, because `http` already says it faces
   * the network; there is no `mcp: true`, and a new vertical writes nothing here. Two
   * things a declaration cannot derive:
   *
   * - `false` — **never a tool, for anyone**. The recording and service operations a
   *   harness calls on its own behalf (`record-answer` and its siblings) are reachable
   *   over HTTP because a connector posts to them, and are noise in an agent's tool
   *   list. This is declaration-time curation, and it is the only kind that belongs in
   *   a model: which tools a given CONSUMER wants is a fact about the consumer (#111),
   *   not about the operation.
   * - `description` — what the MODEL is told. `summary` is written for an API document
   *   ("The desk's settings") and answers "what is this", where tool selection needs
   *   "when would I reach for this". Say more only where the difference bites.
   */
  readonly mcp?: false | { readonly description?: string };
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
  /**
   * This operation reaches an entity IN THE TRASH (#119). Absent — the default, and the right
   * answer for nearly every operation — the HOST refuses it on a trashed entity before the
   * guards and the handler run: `not_found` to a caller who holds the operation's key on the
   * entity, and the same `forbidden` as on an active one to a caller who does not. So a binned
   * entity is gone from everyone's point of view without each handler remembering to ask.
   *
   * - `'admits'` — the operation works on a trashed entity too: the restore, a read of the bin.
   * - `'purges'` — the operation is the entity's PERMANENT delete. It admits a trashed entity,
   *   and it is the one a declared `trash.purgeAfterDays` horizon runs (`purgeSchedulesOf`).
   *   One per entity, and its input is the id and NOTHING else — not even an optional field, so a
   *   purge can only ever reach the entity it was invoked for.
   *
   * Only legal where the host can see the entity: a leading `permission: { entity, idFrom }`
   * naming an entity that declares `trash`. Anywhere else it is a compile error, because there
   * would be nothing for it to opt out of. An operation that narrows `resolved`, by `refFrom`
   * or through `narrows` is not refused by the host at all, and keeps its own check
   * (`trashRefusalGapsOf` names them).
   */
  readonly trashed?: TrashedShape<O, Entities>;
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
     * `erasable` or `outsideText`. Immutable events are the one place in a scope an
     * erasure cannot reach, and no cleanup of the row reaches them either.
     */
    readonly payload?: readonly Exclude<
      OutputKeys<O>,
      ErasableOf<Entities, Engines, O> | OutsideTextOf<Entities, Engines, O>
    >[];
  } & PiiShape<O, OutputKeys<O>>;
  /**
   * Per-field permission on the projection: omission, not denial. The caller
   * still gets the row, without the fields they may not see.
   */
  readonly gates?: { readonly [F in OutputKeys<O>]?: PermKey };
} & OpAuthority<O, Entities, Engines, PermKey> &
  (O extends { derive: unknown } ? { readonly authored?: never } : unknown);

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
    assertPatchInputs(operations);
    assertTrashedDeclarations(operations, entities);
    assertHandlersDeclared(operations, entities);
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

type PatchSchemaIssue = { kind: 'default' } | { kind: 'uninspectable'; schemaKind: string } | null;

/** A default fills an absent PATCH field before its handler can preserve the old value. */
function inputDefaultIssue(schema: unknown): PatchSchemaIssue {
  const pending = [schema];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || current === null || seen.has(current)) continue;
    seen.add(current);
    const def = (current as { _zod?: { def?: unknown } })?._zod?.def as
      | {
          type?: string;
          innerType?: unknown;
          in?: unknown;
          out?: unknown;
          getter?: () => unknown;
          shape?: Record<string, unknown> | (() => Record<string, unknown>);
          element?: unknown;
          keyType?: unknown;
          valueType?: unknown;
          options?: unknown[];
          items?: unknown[];
          rest?: unknown;
          left?: unknown;
          right?: unknown;
          catchall?: unknown;
          checks?: unknown;
          transform?: unknown;
          reverseTransform?: unknown;
        }
      | undefined;
    if (def?.type === 'default' || def?.type === 'prefault' || def?.type === 'catch') return { kind: 'default' };
    if (typeof def?.type !== 'string') return { kind: 'uninspectable', schemaKind: 'unknown' };
    const checkIssue = checksIssue({ type: def.type, checks: def.checks });
    if (checkIssue) return checkIssue;
    switch (def.type) {
      case 'optional':
      case 'nullable':
      case 'nullish':
      case 'readonly':
        pending.push(def.innerType);
        break;
      case 'lazy':
        try {
          pending.push(def.getter?.());
        } catch {
          return { kind: 'uninspectable', schemaKind: 'lazy' };
        }
        break;
      case 'object': {
        try {
          const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
          if (!shape || typeof shape !== 'object') return { kind: 'uninspectable', schemaKind: 'object' };
          pending.push(...Object.values(shape), def.catchall);
        } catch {
          return { kind: 'uninspectable', schemaKind: 'object' };
        }
        break;
      }
      case 'array':
        pending.push(def.element);
        break;
      case 'record':
      case 'map':
        pending.push(def.keyType, def.valueType);
        break;
      case 'set':
        pending.push(def.valueType);
        break;
      case 'union':
        if (!Array.isArray(def.options)) return { kind: 'uninspectable', schemaKind: 'union' };
        pending.push(...def.options);
        break;
      case 'tuple':
        if (!Array.isArray(def.items)) return { kind: 'uninspectable', schemaKind: 'tuple' };
        pending.push(...def.items, def.rest);
        break;
      case 'intersection':
        pending.push(def.left, def.right);
        break;
      case 'pipe':
        if (def.transform !== undefined || def.reverseTransform !== undefined) {
          return { kind: 'uninspectable', schemaKind: 'pipe transform' };
        }
        pending.push(def.in, def.out);
        break;
      // These kinds cannot contain another schema that can apply a default.
      case 'string':
      case 'number':
      case 'boolean':
      case 'bigint':
      case 'date':
      case 'symbol':
      case 'undefined':
      case 'null':
      case 'any':
      case 'unknown':
      case 'never':
      case 'void':
      case 'literal':
      case 'enum':
      case 'file':
      case 'template_literal':
      case 'function':
        break;
      default:
        return { kind: 'uninspectable', schemaKind: def.type };
    }
  }
  return null;
}

/** A check that can change the parsed value, judged on one node; its children are walked elsewhere. */
function checksIssue(def: { type: string; checks?: unknown }): PatchSchemaIssue {
  if (def.checks === undefined) return null;
  if (!Array.isArray(def.checks)) return { kind: 'uninspectable', schemaKind: `${def.type} checks` };
  for (const check of def.checks) {
    const checkDef = (check as { _zod?: { def?: unknown }; def?: unknown })?._zod?.def ??
      (check as { def?: unknown })?.def;
    const checkKind = (checkDef as { check?: unknown; type?: unknown } | undefined)?.check ??
      (checkDef as { type?: unknown } | undefined)?.type;
    // A named string normalizer rewrites only a string the caller supplied, so it
    // cannot give an omitted field a value.
    if (checkKind === 'overwrite' && def.type === 'string' && isStringNormalizer(checkDef)) continue;
    // Zod check classes are extensible. Permit only known validation checks;
    // overwrite and future check kinds could change the parsed value.
    if (typeof checkKind !== 'string' || !PATCH_VALUE_PRESERVING_CHECKS.has(checkKind)) {
      return { kind: 'uninspectable', schemaKind: typeof checkKind === 'string' ? checkKind : `${def.type} check` };
    }
  }
  return null;
}

/**
 * The input object itself: a plain object, so its fields are the body, and nothing on it
 * that can rewrite the parsed body as a whole.
 */
function inputRootIssue(input: unknown): PatchSchemaIssue {
  if (input === undefined) return null;
  const def = (input as { _zod?: { def?: unknown } })?._zod?.def as
    | { type?: unknown; checks?: unknown; catchall?: unknown }
    | undefined;
  if (typeof def?.type !== 'string') return { kind: 'uninspectable', schemaKind: 'unknown' };
  if (def.type !== 'object') return { kind: 'uninspectable', schemaKind: def.type };
  return checksIssue({ type: def.type, checks: def.checks }) ?? inputDefaultIssue(def.catchall);
}

const PATCH_VALUE_PRESERVING_CHECKS = new Set([
  'min_length',
  'max_length',
  'length_equals',
  'string_format',
  'greater_than',
  'less_than',
  'number_format',
  'number_multiple_of',
  'bigint_format',
  'date_minimum',
  'date_maximum',
  'mime_type',
  'size',
  'property',
  'custom',
]);

let stringNormalizerSources: Set<string> | undefined;

/**
 * Zod builds `.trim()`, `.toLowerCase()`, `.toUpperCase()` and `.normalize()` as overwrite
 * checks with a fresh closure each time, so they are recognized by their source text, read
 * from the same Zod this package loads. A custom `.overwrite()` is arbitrary code and does
 * not match, even on a string.
 */
function isStringNormalizer(checkDef: unknown): boolean {
  const tx = (checkDef as { tx?: unknown } | undefined)?.tx;
  if (typeof tx !== 'function') return false;
  stringNormalizerSources ??= new Set(
    [z.string().trim(), z.string().toLowerCase(), z.string().toUpperCase(), z.string().normalize()].map(
      (schema) => String((schema._zod.def.checks?.[0]?._zod.def as { tx?: unknown } | undefined)?.tx),
    ),
  );
  return stringNormalizerSources.has(Function.prototype.toString.call(tx));
}

/** Check the effective HTTP method, both on local operations and bound engine routes. */
function assertPatchInputs(operations: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(operations)) {
    const op = value as {
      http?: { method?: string; path?: string };
      input?: z.ZodObject<z.ZodRawShape>;
      patchException?: unknown;
    };
    const reason = op.patchException;
    if (reason !== undefined && (typeof reason !== 'string' || reason.trim() === '')) {
      throw new Error(`model: '${name}' declares patchException without a reason`);
    }
    if (op.http?.method !== 'PATCH' || reason !== undefined) continue;
    const rootIssue = inputRootIssue(op.input);
    if (rootIssue !== null) {
      const offence = rootIssue.kind === 'default'
        ? 'has a default'
        : `uses an uninspectable Zod schema kind '${rootIssue.schemaKind}'`;
      throw new Error(
        `model: '${name}' routes as PATCH, but its input object ${offence}; ` +
          'route it as PUT, drop the hook that rewrites the body, or declare patchException with a reason',
      );
    }
    const pathFields = new Set(Array.from((op.http.path ?? '').matchAll(/\{([^}]+)\}/g), (match) => match[1]));
    for (const [field, schema] of Object.entries(op.input?.shape ?? {})) {
      if (pathFields.has(field)) continue;
      const issue = inputDefaultIssue(schema);
      const offence = issue?.kind === 'default'
        ? 'has a default'
        : issue?.kind === 'uninspectable'
          ? `uses an uninspectable Zod schema kind '${issue.schemaKind}'`
          : !isOptionalSchema(schema)
            ? 'is required'
            : null;
      if (offence !== null) {
        throw new Error(
          `model: '${name}' routes as PATCH, but body field '${field}' ${offence}; ` +
            'route it as PUT, make the field optional without a default, or declare patchException with a reason',
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Handlers the platform derives, and the exception that writes one by hand (#1773).
// ---------------------------------------------------------------------------

/**
 * The shapes the model already describes completely, so the platform writes the handler.
 *
 * Each is matched EXACTLY — every clause below is something the derived handler relies on, and a
 * declaration that misses one is a command with its own body, not a near-miss to be stretched:
 *
 * - `get` — one row by its id. Input is the id alone, the output IS the entity's `fields`, and
 *   nothing is emitted. The check is a scope key, or narrowed to that same row.
 * - `list` — a kernel-composed page (`paged.over`) of the entity's own rows, the output IS its
 *   `fields`. Every input field is one of its declared `filterable` columns; a check narrowed to a
 *   PARENT scopes the page to that parent's rows through the parent's id column.
 * - `update` — the partial `PATCH`. Absent fields are left as they are and `null` clears a
 *   nullable column; `concurrency` over the row is required, so the field bag cannot lose an
 *   update. Emits about the row, and answers with it.
 * - `delete` — removes one row with no child entity (a cascade is authored), emits, and answers
 *   `{ id, deleted: true }`.
 *
 * A derived handler checks the declared permission first, reads and writes only the entity's
 * declared columns through `ctx.sql`, and answers `not_found` for a missing row — the same steps
 * a hand-written one takes, written once.
 *
 * `create` is not here yet: the id, the timestamps and the parent link it would write are not all
 * declared. Neither are hooks around a derived handler.
 */
export type DerivedKind = 'get' | 'list' | 'update' | 'delete';

const DERIVED_KINDS: readonly DerivedKind[] = ['get', 'list', 'update', 'delete'];

/** The keys of the operations whose handler the platform writes. */
export type DerivedKeys<Ops> = {
  [K in keyof Ops]: Ops[K] extends { derive: DerivedKind } ? K : never;
}[keyof Ops];

/** The event a derived write emits, read off the operation's own `emits`. */
export interface DerivedEmit {
  readonly type: string;
  readonly schemaVersion: number;
  readonly piiClass: 'none' | 'pseudonymous' | 'direct';
  /** The OUTPUT field carrying the data subject, for a classified event. */
  readonly subjectId?: string;
  /** The OUTPUT fields the payload carries, in declared order. */
  readonly payload: readonly string[];
}

/**
 * Everything a derived handler needs, resolved from the declaration once, at module load. The
 * kernel builds the handler from this and nothing else, so the handler cannot read a field the
 * declaration did not name.
 */
export type DerivationPlan = {
  readonly entity: string;
  readonly table: string;
  /** The single primary-key column. */
  readonly primaryKey: string;
  /** Every declared column, in declared order — what a derived read names instead of `*`. */
  readonly columns: readonly string[];
  /** The leading check: a scope key, or narrowed to `entity` by the id in input field `idFrom`. */
  readonly permission: { readonly key: string; readonly entity?: string; readonly idFrom?: string };
} & (
  | { readonly kind: 'get'; readonly idFrom: string }
  | {
      readonly kind: 'list';
      /** input field → the column it filters, the parent's id field included. */
      readonly filters: readonly { readonly field: string; readonly column: string }[];
      readonly total: boolean;
    }
  | {
      readonly kind: 'update';
      readonly idFrom: string;
      /** input field → the column it writes. */
      readonly fields: readonly { readonly field: string; readonly column: string }[];
      readonly emit: DerivedEmit;
    }
  | { readonly kind: 'delete'; readonly idFrom: string; readonly emit: DerivedEmit }
);

/**
 * Every derived declaration's plan, keyed by the declaration object itself. Keyed per operation
 * rather than per map so a module that spreads its operations into a larger map still reaches
 * them, and module-private so nothing but `defineOperations` can say what a handler does.
 */
const DERIVATION_PLANS = new WeakMap<object, DerivationPlan>();

/**
 * The plan `defineOperations` recorded for a `derive` declaration — `undefined` for anything else,
 * including a declaration that never passed through `defineOperations`.
 */
export function derivationPlanOf(operation: object): DerivationPlan | undefined {
  return DERIVATION_PLANS.get(operation);
}

type DeclarationRead = {
  input?: z.ZodObject<z.ZodRawShape>;
  inputOptional?: unknown;
  output?: unknown;
  http?: { method?: string };
  permission?: unknown;
  narrows?: unknown;
  emits?: {
    entity?: unknown;
    entityIdFrom?: unknown;
    type?: unknown;
    schemaVersion?: unknown;
    piiClass?: unknown;
    subjectId?: unknown;
    payload?: readonly string[];
  };
  paged?: { over?: { entity?: unknown; filterable?: readonly string[] }; total?: unknown };
  concurrency?: { over?: unknown; idFrom?: unknown };
  gates?: unknown;
  trashed?: unknown;
  patchException?: unknown;
  derive?: unknown;
  authored?: unknown;
};

/** The zod def a structural read sees, through the wrappers that only change optionality. */
function baseDefOf(schema: unknown): { type?: string } | undefined {
  let current = schema;
  for (let depth = 0; depth < 8; depth++) {
    const def = (current as { _zod?: { def?: unknown } })?._zod?.def as
      | { type?: string; innerType?: unknown }
      | undefined;
    if (!def) return undefined;
    if (def.type === 'optional' || def.type === 'nullable' || def.type === 'nullish' || def.type === 'readonly') {
      current = def.innerType;
      continue;
    }
    return def;
  }
  return undefined;
}

/** Does this schema admit `null`, through the wrappers that do not change that answer? */
function acceptsNull(schema: unknown): boolean {
  let current = schema;
  for (let depth = 0; depth < 8; depth++) {
    const def = (current as { _zod?: { def?: unknown } })?._zod?.def as
      | { type?: string; innerType?: unknown }
      | undefined;
    if (def?.type === 'nullable' || def?.type === 'nullish') return true;
    if (def?.type !== 'optional' && def?.type !== 'readonly') return false;
    current = def.innerType;
  }
  return false;
}

/** The column kinds a derived write binds as they arrive: a JSON or boolean column needs encoding. */
const DERIVED_WRITE_KINDS = new Set(['string', 'number', 'literal']);

/** This module's entity whose `fields` the output IS, by identity — a projection is not the row. */
function entityOfOutput(output: unknown, entities: Record<string, EntityDef>): string | undefined {
  return Object.keys(entities).find((name) => entities[name]?.fields === output);
}

/** A plan's common half, or the clause the entity fails. */
function derivableEntity(
  entityName: string,
  entities: Record<string, EntityDef>,
): { entity: EntityDef; primaryKey: string; columns: string[] } | string {
  const entity = entities[entityName];
  if (!entity) return `'${entityName}' is not this module's entity — a composed engine's table is the engine's to read`;
  const primaryKey = primaryKeyOf(entityName, entity);
  if (primaryKey.length !== 1) return `'${entityName}' has a composite primary key, so no one id addresses a row`;
  return { entity, primaryKey: primaryKey[0] as string, columns: Object.keys(entity.fields.shape) };
}

/** The leading check, read back: a scope key, `{ key, entity, idFrom }`, or the clause it fails. */
function plainPermission(
  permission: unknown,
): { key: string; entity?: string; idFrom?: string } | string {
  if (typeof permission === 'string') return { key: permission };
  const p = permission as { key?: unknown; entity?: unknown; idFrom?: unknown } | undefined;
  if (typeof p?.key === 'string' && typeof p.entity === 'string' && typeof p.idFrom === 'string') {
    return { key: p.key, entity: p.entity, idFrom: p.idFrom };
  }
  return 'its permission is resolved, carried in a ref, or narrowed per row — the derived check is a scope key or `{ key, entity, idFrom }`';
}

function emitOf(decl: DeclarationRead): DerivedEmit {
  const e = decl.emits ?? {};
  return {
    type: e.type as string,
    schemaVersion: e.schemaVersion as number,
    piiClass: e.piiClass as DerivedEmit['piiClass'],
    ...(typeof e.subjectId === 'string' ? { subjectId: e.subjectId } : {}),
    payload: [...(e.payload ?? [])],
  };
}

/** The input's fields, split by whether a caller may omit them. */
function inputFields(decl: DeclarationRead): { required: string[]; optional: string[] } {
  const required: string[] = [];
  const optional: string[] = [];
  for (const [field, schema] of Object.entries(decl.input?.shape ?? {})) {
    (isOptionalSchema(schema) ? optional : required).push(field);
  }
  return { required, optional };
}

/** Clauses every derived shape shares: no per-row walk, no per-field projection, no bin access. */
function commonClause(decl: DeclarationRead, kind: DerivedKind): string | null {
  if (decl.narrows !== undefined) return 'it narrows per row (`narrows`), which is a walk the handler composes';
  if (decl.gates !== undefined) return 'it gates fields (`gates`), a projection the handler applies';
  if (decl.inputOptional !== undefined) return 'it declares `inputOptional`';
  if (decl.trashed !== undefined && !(kind === 'delete' && decl.trashed === 'purges')) {
    return `it declares \`trashed: '${String(decl.trashed)}'\` — reaching the bin is authored`;
  }
  return null;
}

function getPlan(decl: DeclarationRead, entities: Record<string, EntityDef>): DerivationPlan | string {
  const common = commonClause(decl, 'get');
  if (common) return common;
  if (decl.paged !== undefined) return 'it is paged — a page is a `list`';
  if (decl.emits !== undefined) return 'it emits, and a read announces nothing';
  if (decl.http?.method !== undefined && decl.http.method !== 'GET') return `it is served as ${decl.http.method}, not GET`;
  const name = entityOfOutput(decl.output, entities);
  if (name === undefined) return "its output is not one of this module's entities' own `fields`";
  const base = derivableEntity(name, entities);
  if (typeof base === 'string') return base;
  const { required, optional } = inputFields(decl);
  if (required.length !== 1 || optional.length !== 0) return 'its input is not the id alone';
  const idFrom = required[0] as string;
  const permission = plainPermission(decl.permission);
  if (typeof permission === 'string') return permission;
  if (permission.entity !== undefined && (permission.entity !== name || permission.idFrom !== idFrom)) {
    return `its check narrows to '${permission.entity}' by '${String(permission.idFrom)}', not to the row it reads`;
  }
  if (permission.entity === undefined && base.entity.trash !== undefined) {
    return `'${name}' declares \`trash\`, and only a check narrowed to the row lets the host refuse a binned one`;
  }
  return { kind: 'get', entity: name, table: base.entity.table, primaryKey: base.primaryKey, columns: base.columns, permission, idFrom };
}

function listPlan(decl: DeclarationRead, entities: Record<string, EntityDef>): DerivationPlan | string {
  const common = commonClause(decl, 'list');
  if (common) return common;
  const over = decl.paged?.over;
  if (over === undefined) return 'it is not a kernel-composed page (`paged.over`)';
  const name = over.entity as string;
  if (decl.output !== entities[name]?.fields) return `its output is not '${name}'s own \`fields\``;
  const base = derivableEntity(name, entities);
  if (typeof base === 'string') return base;
  const permission = plainPermission(decl.permission);
  if (typeof permission === 'string') return permission;
  const filterable = new Set(over.filterable ?? []);
  const filters: { field: string; column: string }[] = [];
  const { required, optional } = inputFields(decl);
  if (permission.entity !== undefined) {
    if (!(base.entity.parents ?? []).includes(permission.entity)) {
      return `its check narrows to '${permission.entity}', which is not a parent of '${name}'`;
    }
    const idFrom = permission.idFrom as string;
    const column = snakeCaseField(idFrom);
    if (!required.includes(idFrom) || !filterable.has(column)) {
      return `the parent's id '${idFrom}' is not a required input filtering the declared \`filterable\` column '${column}'`;
    }
    filters.push({ field: idFrom, column });
  }
  for (const field of required) {
    if (field !== permission.idFrom) return `input field '${field}' is required, and only the parent's id may be`;
  }
  for (const field of optional) {
    const column = snakeCaseField(field);
    if (!filterable.has(column)) return `input field '${field}' is not a declared \`filterable\` column`;
    if (inputDefaultIssue(decl.input?.shape[field]) !== null) return `input field '${field}' has a default`;
    filters.push({ field, column });
  }
  return {
    kind: 'list',
    entity: name,
    table: base.entity.table,
    primaryKey: base.primaryKey,
    columns: base.columns,
    permission,
    filters,
    total: decl.paged?.total === true,
  };
}

/** The clauses a derived write shares: narrowed to the row it writes, announcing it, by that row's id. */
function writeTarget(
  decl: DeclarationRead,
  entities: Record<string, EntityDef>,
): { name: string; base: Exclude<ReturnType<typeof derivableEntity>, string>; idFrom: string; key: string } | string {
  const permission = plainPermission(decl.permission);
  if (typeof permission === 'string') return permission;
  if (permission.entity === undefined) return 'its check is scope-wide, and a derived write is narrowed to the row it writes';
  const name = permission.entity;
  const base = derivableEntity(name, entities);
  if (typeof base === 'string') return base;
  if (decl.emits?.entity !== name) return `it does not emit about '${name}', the row it writes`;
  if (decl.emits.entityIdFrom !== base.primaryKey) {
    return `its event takes its subject from '${String(decl.emits.entityIdFrom)}', not the row's id '${base.primaryKey}'`;
  }
  return { name, base, idFrom: permission.idFrom as string, key: permission.key };
}

function updatePlan(decl: DeclarationRead, entities: Record<string, EntityDef>): DerivationPlan | string {
  const common = commonClause(decl, 'update');
  if (common) return common;
  if (decl.http?.method !== 'PATCH') return 'it is not served as PATCH, the method whose absent fields stay untouched';
  if (decl.patchException !== undefined) return 'it declares `patchException`, so its body is not a field bag';
  if (decl.paged !== undefined) return 'it is paged';
  const target = writeTarget(decl, entities);
  if (typeof target === 'string') return target;
  const { name, base, idFrom } = target;
  if (decl.output !== base.entity.fields) return `its output is not '${name}'s own \`fields\``;
  if (decl.concurrency?.over !== name || decl.concurrency.idFrom !== idFrom) {
    return `it declares no \`concurrency: { over: '${name}', idFrom: '${idFrom}' }\`, and a field bag without one loses updates`;
  }
  const { required, optional } = inputFields(decl);
  if (required.length !== 1 || required[0] !== idFrom) return `its input requires more than the id '${idFrom}'`;
  if (optional.length === 0) return 'its input has no field to write';
  const columnShape = base.entity.fields.shape;
  const fields: { field: string; column: string }[] = [];
  for (const field of optional) {
    const column = snakeCaseField(field);
    const columnSchema = columnShape[column];
    if (columnSchema === undefined) return `body field '${field}' is not a column of '${name}'`;
    if (column === base.primaryKey) return `body field '${field}' would rewrite the row's id`;
    const fieldSchema = decl.input?.shape[field];
    const kind = baseDefOf(columnSchema)?.type;
    if (kind === 'enum') {
      return `column '${column}' is an enum — a change of state is a lifecycle edge with its own operation`;
    }
    if (!kind || !DERIVED_WRITE_KINDS.has(kind)) return `column '${column}' is not a string or number column`;
    if (baseDefOf(fieldSchema)?.type !== kind) return `body field '${field}' is not the same type as column '${column}'`;
    if (acceptsNull(fieldSchema) && !acceptsNull(columnSchema)) {
      return `body field '${field}' accepts null, and column '${column}' cannot be cleared`;
    }
    fields.push({ field, column });
  }
  return {
    kind: 'update',
    entity: name,
    table: base.entity.table,
    primaryKey: base.primaryKey,
    columns: base.columns,
    permission: { key: target.key, entity: name, idFrom },
    idFrom,
    fields,
    emit: emitOf(decl),
  };
}

function deletePlan(decl: DeclarationRead, entities: Record<string, EntityDef>): DerivationPlan | string {
  const common = commonClause(decl, 'delete');
  if (common) return common;
  if (decl.http?.method !== undefined && decl.http.method !== 'DELETE') return `it is served as ${decl.http.method}, not DELETE`;
  if (decl.paged !== undefined) return 'it is paged';
  const target = writeTarget(decl, entities);
  if (typeof target === 'string') return target;
  const { name, base, idFrom } = target;
  const outputKeys = Object.keys((decl.output as z.ZodObject<z.ZodRawShape> | undefined)?.shape ?? {}).sort();
  if (outputKeys.join() !== 'deleted,id') return 'its output is not `{ id, deleted }`';
  const { required, optional } = inputFields(decl);
  if (required.length !== 1 || required[0] !== idFrom || optional.length !== 0) return `its input is not the id '${idFrom}' alone`;
  const children = Object.keys(entities).filter((child) => (entities[child]?.parents ?? []).includes(name));
  if (children.length > 0) {
    return `${children.map((c) => `'${c}'`).join(', ')} declare${children.length === 1 ? 's' : ''} '${name}' as parent, so a delete would orphan them — a cascade is authored`;
  }
  return {
    kind: 'delete',
    entity: name,
    table: base.entity.table,
    primaryKey: base.primaryKey,
    columns: base.columns,
    permission: { key: target.key, entity: name, idFrom },
    idFrom,
    emit: emitOf(decl),
  };
}

const PLANNERS: Record<DerivedKind, typeof getPlan> = {
  get: getPlan,
  list: listPlan,
  update: updatePlan,
  delete: deletePlan,
};

/**
 * Which shape the platform could derive this declaration as, if any — read off the declaration
 * alone. At most one matches: a `get` is not paged and emits nothing, a `list` is paged, an
 * `update` is a PATCH that emits, a `delete` answers `{ id, deleted }`.
 */
function derivablePlanOf(decl: DeclarationRead, entities: Record<string, EntityDef>): DerivationPlan | undefined {
  for (const kind of DERIVED_KINDS) {
    const plan = PLANNERS[kind](decl, entities);
    if (typeof plan !== 'string') return plan;
  }
  return undefined;
}

/**
 * A handler the platform could write is either written by it or excused, by name (#1773).
 *
 * Runs at module load, beside the PATCH and paged gates, and for their reason: it fires in every
 * build, test, dev server and `lint:model --check`, so it cannot be true only of the modules a
 * tool knew about. A derivable operation declaring neither `derive` nor `authored` is refused;
 * so are a `derive` whose shape does not match (with the clause that fails), an `authored` on
 * an operation nothing could derive, and the two together.
 */
function assertHandlersDeclared(operations: Record<string, unknown>, entities: Record<string, EntityDef>): void {
  for (const [name, op] of Object.entries(operations)) {
    const decl = op as DeclarationRead;
    const { derive, authored } = decl;
    if (derive !== undefined && authored !== undefined) {
      throw new Error(
        `model: '${name}' declares both \`derive\` and \`authored\` — a handler is written by the platform or by you, not both`,
      );
    }
    if (authored !== undefined && (typeof authored !== 'string' || authored.trim() === '')) {
      throw new Error(`model: '${name}' declares authored without a reason`);
    }
    if (derive !== undefined) {
      if (!DERIVED_KINDS.includes(derive as DerivedKind)) {
        throw new Error(`model: '${name}' declares \`derive: '${String(derive)}'\` — the derivable shapes are ${DERIVED_KINDS.join(', ')}`);
      }
      const plan = PLANNERS[derive as DerivedKind](decl, entities);
      if (typeof plan === 'string') {
        throw new Error(
          `model: '${name}' declares \`derive: '${String(derive)}'\`, but ${plan}.\n` +
            '  Remedy: make the declaration the shape it derives, or drop `derive` and write the handler.',
        );
      }
      DERIVATION_PLANS.set(op as object, plan);
      continue;
    }
    const plan = derivablePlanOf(decl, entities);
    if (plan === undefined) {
      if (authored !== undefined) {
        throw new Error(
          `model: '${name}' declares \`authored\`, but nothing about it is derivable — it matches none of ` +
            `${DERIVED_KINDS.join(', ')}, so every handler for it is authored already. Remove \`authored\`.`,
        );
      }
      continue;
    }
    if (authored !== undefined) continue;
    throw new Error(
      `model: '${name}' is derivable from the model as \`${plan.kind}\` over '${plan.entity}', and declares neither ` +
        '`derive` nor `authored`.\n' +
        `  A hand-written ${plan.kind} restates its declaration, and each restatement drifts (#1773).\n` +
        `  Remedy: declare \`derive: '${plan.kind}'\` and delete its handler, or declare ` +
        `\`authored: '<why the derived ${plan.kind} is wrong here>'\`.`,
    );
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
 * The entity an operation addresses by id, as the host reads it (#119).
 *
 * `key` is the operation's DECLARED leading check, which the host evaluates itself before it
 * refuses a trashed entity — so a caller without the key meets the same `forbidden` there that
 * the handler would have given on an active one, and learns nothing about the bin.
 */
export interface OperationTarget {
  readonly entity: string;
  readonly idFrom: string;
  readonly key: string;
  readonly trashed?: 'admits' | 'purges';
}

/**
 * name → the entity each operation addresses by id, for the host (#119).
 *
 * Every operation whose leading check is `{ entity, idFrom }`, whether or not its entity
 * declares `trash` — the host keeps the ones whose entity does. Handed over beside
 * `operationInputs`, and required by the host from any module with a trashable entity, so a
 * module cannot leave its binned entities reachable by forgetting the line.
 */
export function operationTargetsOf(
  operations: Readonly<Record<string, object>>,
): Record<string, OperationTarget> {
  const out: Record<string, OperationTarget> = {};
  for (const [name, op] of Object.entries(operations)) {
    const decl = op as { permission?: { key?: unknown; entity?: unknown; idFrom?: unknown }; trashed?: unknown };
    const p = decl.permission;
    if (typeof p !== 'object' || p === null) continue;
    if (typeof p.key !== 'string' || typeof p.entity !== 'string' || typeof p.idFrom !== 'string') continue;
    out[name] = {
      entity: p.entity,
      idFrom: p.idFrom,
      key: p.key,
      ...(decl.trashed === 'admits' || decl.trashed === 'purges' ? { trashed: decl.trashed } : {}),
    };
  }
  return out;
}

/** How often a purge horizon's schedule runs (#119). The horizon is in days; hourly is plenty. */
export const PURGE_CADENCE_MINUTES = 60;

/**
 * The schedules a module's purge horizons run as (#119), derived — spread into the manifest's
 * `schedules` beside any the module writes:
 *
 * ```ts
 * schedules: purgeSchedulesOf(todoOperations, todoEntities),
 * ```
 *
 * One per entity declaring `trash.purgeAfterDays`, running the operation that declares
 * `trashed: 'purges'` for it, holding exactly that operation's key. Being a schedule is what
 * gives the purge everything a schedule already has: the module's system principal and its
 * seated grant (rendered in `PERMISSIONS.md`), the kill switch, the lifecycle hold, the
 * exclusion of preview copies, and a sweeper on a pushed deploy.
 *
 * Refuses a horizon with no purging operation, and a purging operation whose input needs
 * more than the id — the sweep has nothing else to pass it.
 */
export function purgeSchedulesOf(
  operations: Readonly<Record<string, object>>,
  entities: Readonly<Record<string, EntityDef>>,
): { operation: string; cadence: { everyMinutes: number }; permissions: string[]; purge: { entityType: string } }[] {
  const targets = operationTargetsOf(operations);
  const out = [];
  for (const entityType of Object.keys(entities).sort()) {
    const days = entities[entityType]?.trash?.purgeAfterDays;
    if (days === undefined) continue;
    const purging = Object.entries(targets).filter(([, t]) => t.entity === entityType && t.trashed === 'purges');
    if (purging.length !== 1) {
      throw new Error(
        `model: '${entityType}' declares trash.purgeAfterDays but ` +
          (purging.length === 0
            ? "no operation declares `trashed: 'purges'` for it — the horizon has nothing to run.\n" +
              "  Remedy: mark the entity's permanent delete `trashed: 'purges'`."
            : `${purging.map(([n]) => `'${n}'`).join(', ')} all declare \`trashed: 'purges'\` for it — one permanent delete per entity.`),
      );
    }
    const [operation, target] = purging[0]!;
    out.push({
      operation,
      cadence: { everyMinutes: PURGE_CADENCE_MINUTES },
      permissions: [target.key],
      purge: { entityType },
    });
  }
  return out;
}

/**
 * The operations on a trashable entity the HOST cannot refuse on a trashed one (#119), because
 * their check names the entity but not the input field carrying its id — it is `resolved` in the
 * handler. Each keeps its own `ctx.entityState` check. `lint:model` prints them as warnings, so
 * the gap is seen when a vertical is built rather than found in review.
 *
 * What it cannot name, and K-45 states: an operation that reaches a trashable entity with no
 * entity in its check at all — a `narrows` walk, a `refFrom` check, a node-level key.
 */
export function trashRefusalGapsOf(
  operations: Readonly<Record<string, object>>,
  entities: Readonly<Record<string, EntityDef>>,
): { operation: string; entity: string }[] {
  const targets = operationTargetsOf(operations);
  const out: { operation: string; entity: string }[] = [];
  for (const [name, op] of Object.entries(operations).sort(([a], [b]) => a.localeCompare(b))) {
    const checked = (op as { permission?: { entity?: unknown } }).permission?.entity;
    if (typeof checked !== 'string' || !entities[checked]?.trash || targets[name]) continue;
    out.push({ operation: name, entity: checked });
  }
  return out;
}

/**
 * `trashed`'s compile-time rule, held at load time too (#119) — an operations object built
 * around the types (a cast, a generated map) must not opt out of a refusal the host cannot
 * then see.
 */
function assertTrashedDeclarations(
  operations: Record<string, unknown>,
  entities: Record<string, EntityDef>,
): void {
  const purges = new Map<string, string>();
  const targets = operationTargetsOf(operations as Record<string, object>);
  for (const [name, op] of Object.entries(operations)) {
    const decl = op as { trashed?: unknown; permission?: unknown; input?: z.ZodObject<z.ZodRawShape> };
    if (decl.trashed === undefined) continue;
    const target = targets[name];
    if ((decl.trashed !== 'admits' && decl.trashed !== 'purges') || !target || !entities[target.entity]?.trash) {
      throw new Error(
        `model: '${name}' declares \`trashed: ${JSON.stringify(decl.trashed)}\` — it is 'admits' or 'purges', ` +
          'and only on an operation whose check is `{ entity, idFrom }` over an entity that declares `trash`',
      );
    }
    if (decl.trashed !== 'purges') continue;
    const other = purges.get(target.entity);
    if (other) {
      throw new Error(`model: '${other}' and '${name}' both declare \`trashed: 'purges'\` for '${target.entity}' — one permanent delete per entity`);
    }
    purges.set(target.entity, name);
    const extra = Object.keys(decl.input?.shape ?? {}).filter((field) => field !== target.idFrom);
    if (extra.length > 0) {
      throw new Error(
        `model: '${name}' declares \`trashed: 'purges'\` but its input also takes ${extra.map((f) => `\`${f}\``).join(', ')} — ` +
          `a purge's input is the id (\`${target.idFrom}\`) and nothing else, optional fields included`,
      );
    }
    if (!isStrictObjectSchema(decl.input)) {
      throw new Error(
        `model: '${name}' declares \`trashed: 'purges'\` but its input is not a strict object — a passthrough or ` +
          'default object would let the call carry, or quietly drop, fields beside the id.\n' +
          `  Remedy: \`input: z.strictObject({ ${target.idFrom}: … })\`.`,
      );
    }
  }
}

/**
 * Whether `schema` is a zod object that REFUSES unknown keys (`z.strictObject`, `.strict()`) —
 * what a `trashed: 'purges'` operation's input must be (#119), so that the parsed input is the id
 * and nothing else: a passthrough object keeps an extra field, and a default one drops it silently.
 */
export function isStrictObjectSchema(schema: unknown): boolean {
  const def = (schema as { _zod?: { def?: { type?: unknown; catchall?: { _zod?: { def?: { type?: unknown } } } } } } | undefined)?._zod?.def;
  return def?.type === 'object' && def.catchall?._zod?.def?.type === 'never';
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
 * The event types an operation set lets other verticals receive, for
 * `manifest.events.exports` (#1705) — derived from the same `emits` declarations
 * `eventsEmittedBy` reads, so an export and the event it names cannot describe
 * different versions.
 *
 * ```ts
 * exports: eventsExportedBy(ops, { 'crm.customer-created': 'customer:read' }),
 * ```
 *
 * This is where the PII rule is held at declaration: a type is exportable only if
 * EVERY operation declaring it classifies it `piiClass: 'none'`. One operation that
 * emits the same type as `direct` makes the type unexportable, because the export read
 * cannot tell from the type which instance it is holding. It withholds the classified
 * row anyway, and then the export silently delivers less than it promised. Throwing here,
 * at module load, puts the refusal in front of the author instead.
 *
 * Also refused: a type no operation emits (a typo, or an event this module never
 * produces), and a type declared at two schemaVersions (there is no single version
 * to promise).
 */
export function eventsExportedBy(
  operations: Readonly<Record<string, object>>,
  exports: Readonly<Record<string, string>>,
): { type: string; schemaVersion: number; readPermission: string }[] {
  const declared = new Map<string, { versions: Set<number>; classified: string[] }>();
  for (const [name, op] of Object.entries(operations)) {
    const emits = (op as { emits?: { type?: unknown; schemaVersion?: unknown; piiClass?: unknown } }).emits;
    if (typeof emits?.type !== 'string' || typeof emits.schemaVersion !== 'number') continue;
    const seen = declared.get(emits.type) ?? { versions: new Set<number>(), classified: [] };
    seen.versions.add(emits.schemaVersion);
    if (emits.piiClass !== 'none') seen.classified.push(`${name} (${String(emits.piiClass)})`);
    declared.set(emits.type, seen);
  }
  return Object.entries(exports)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, readPermission]) => {
      const seen = declared.get(type);
      if (!seen) {
        throw new Error(
          `eventsExportedBy: '${type}' is exported but no operation emits it — ` +
            `an export must name an event this module declares in an operation's \`emits\``,
        );
      }
      if (seen.classified.length > 0) {
        throw new Error(
          `eventsExportedBy: '${type}' cannot be exported — ${seen.classified.join(', ')} ` +
            `classif${seen.classified.length === 1 ? 'ies' : 'y'} it as carrying personal data. ` +
            `Only piiClass 'none' crosses a vertical boundary (#1705): a shred in this scope cannot ` +
            `reach what another vertical derived from it. Export a textless event instead, and let ` +
            `the receiving vertical read the subject's data through a governed call.`,
        );
      }
      if (seen.versions.size > 1) {
        throw new Error(
          `eventsExportedBy: '${type}' is emitted at schemaVersions ${[...seen.versions].sort().join(', ')} — ` +
            `an export promises one version; finish the replace (K-39) before exporting it`,
        );
      }
      return { type, schemaVersion: [...seen.versions][0]!, readPermission };
    });
}

/**
 * Each exported event's payload as JSON Schema (#1705 PR 3, D-22), for `emitModel`'s `exports`:
 *
 * ```ts
 * const exported = eventsExportedBy(ops, { 'crm.customer-created': 'customer:read' });
 * export const crmModel = emitModel(crmEntities, { exports: exportedEventSchemasOf(ops, exported) });
 * ```
 *
 * The payload is what `emits.payload` declares: those fields of the operation's `output`. That
 * is the promise another vertical parses against, so it goes into the checked-in model, where
 * `lint:export-schemas` compares it with the base branch's. An operation that declares no
 * `payload` promises an empty object.
 *
 * Refused, at module load:
 * - an export no operation emits (`eventsExportedBy` refuses it too, and this is its backstop);
 * - a payload drawn from an output that is not an object, which has no fields to pick;
 * - two operations emitting one exported type with DIFFERENT payload schemas. A consumer
 *   receives both under one (type, version), so the version would promise two shapes.
 */
export function exportedEventSchemasOf(
  operations: Readonly<Record<string, object>>,
  exports: readonly { type: string; schemaVersion: number; readPermission: string }[],
): ({ type: string } & EmittedExport)[] {
  return exports.map((e) => {
    let payload: Record<string, unknown> | null = null;
    let first = '';
    for (const [name, op] of Object.entries(operations)) {
      const emits = (op as { emits?: { type?: unknown; payload?: readonly string[] } }).emits;
      if (emits?.type !== e.type) continue;
      const output = (op as { output?: unknown }).output;
      const keys = [...(emits.payload ?? [])];
      let picked: z.ZodType;
      if (keys.length === 0) picked = z.object({});
      else if (output instanceof z.ZodObject) {
        picked = output.pick(Object.fromEntries(keys.map((k) => [k, true])) as Record<string, true>);
      } else {
        throw new Error(
          `exportedEventSchemasOf: ${name} emits '${e.type}' with a payload drawn from an output that is not an object`,
        );
      }
      const { $schema: _drop, ...schema } = z.toJSONSchema(picked, { io: 'output', target: 'draft-2020-12' }) as Record<
        string,
        unknown
      >;
      if (payload === null) {
        payload = schema;
        first = name;
      } else if (JSON.stringify(payload) !== JSON.stringify(schema)) {
        throw new Error(
          `exportedEventSchemasOf: '${e.type}' is emitted by ${first} and ${name} with different payloads — ` +
            `one exported (type, schemaVersion) promises one shape`,
        );
      }
    }
    if (payload === null) {
      throw new Error(`exportedEventSchemasOf: '${e.type}' is exported but no operation emits it`);
    }
    return { type: e.type, schemaVersion: e.schemaVersion, readPermission: e.readPermission, payload };
  });
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
/**
 * The `peers` a module declares, derived from the operations each peer may invoke (#1706).
 *
 * A `peers` entry has two halves that must agree: the operations a calling vertical is
 * allowlisted for, and the permission keys it holds while doing so. Written by hand they
 * drift, and drift is silent in the worst direction — a peer allowlisted for an operation
 * whose key it was not given is refused at that operation every time, and the refusal looks
 * like the door working rather than like the declaration being wrong. So the keys are READ
 * off the operations, by the same rule `permissionsUsedBy` reads this module's own surface.
 *
 * ```ts
 * ...peersDeclaredBy(crmOperations, {
 *   'acme/board-room': ['customer/list', 'customer/get'],
 *   // Receive-only (#1705): no operation, so the keys are named — a delivery meets no
 *   // allowlist, and there is nothing to derive them from.
 *   'acme/ledger': { permissions: ['customer:read'] },
 * })
 * ```
 *
 * The operation names are `keyof Ops`, so naming one this module does not declare is a
 * compile error — and a runtime one too, because a cast can dodge the compiler and the
 * artifact of record must not carry a peer pointed at nothing.
 */
export function peersDeclaredBy<const Ops extends Record<string, object>>(
  operations: Ops,
  peers: Readonly<
    Record<
      string,
      | readonly (keyof Ops & string)[]
      | {
          readonly operations?: readonly (keyof Ops & string)[];
          /**
           * The keys this peer holds, when they are not the ones its operations check —
           * required for a receive-only peer, which has no operations to read them from.
           *
           * Naming them does not widen: a key one of its own allowlisted operations checks
           * may not be left out, because the peer would then be allowlisted for a call it is
           * always refused at.
           */
          readonly permissions?: readonly string[];
        }
    >
  >,
): { peers: { vertical: string; operations: string[]; permissions: string[] }[] } {
  const declared = Object.keys(operations);
  const out = Object.keys(peers)
    .sort()
    .map((vertical) => {
      const spec = peers[vertical]! as
        | readonly string[]
        | { readonly operations?: readonly string[]; readonly permissions?: readonly string[] };
      const isList = Array.isArray(spec);
      const named: readonly string[] = isList ? spec : ((spec as { operations?: readonly string[] }).operations ?? []);
      const explicit = isList ? undefined : (spec as { permissions?: readonly string[] }).permissions;
      const unknown = named.filter((op) => !declared.includes(op));
      if (unknown.length > 0) {
        throw new Error(
          `peersDeclaredBy: peer '${vertical}' names operation(s) ${unknown.join(', ')}, which this ` +
            'module does not declare — a peer allowlisted for an operation that does not exist can only ever be refused',
        );
      }
      const needed = permissionsUsedBy(
        Object.fromEntries(named.map((op) => [op, operations[op] as object])) as Record<string, object>,
      );
      if (explicit === undefined && named.length === 0) {
        throw new Error(
          `peersDeclaredBy: peer '${vertical}' names no operation and no permissions — a receive-only ` +
            'peer (#1705) states the keys it holds, since there is nothing to derive them from',
        );
      }
      const permissions = explicit === undefined ? needed : [...new Set(explicit)].sort();
      const missing = needed.filter((key) => !permissions.includes(key));
      if (missing.length > 0) {
        throw new Error(
          `peersDeclaredBy: peer '${vertical}' is allowlisted for operations checking ${missing.join(', ')}, ` +
            'but is not given those keys — it would be refused at its own allowlisted calls',
        );
      }
      if (permissions.length === 0) {
        throw new Error(
          `peersDeclaredBy: peer '${vertical}' would hold no permission — its operations check none, so ` +
            'state the keys it needs, or do not declare it',
        );
      }
      return { vertical, operations: [...named].sort(), permissions };
    });
  return { peers: out };
}

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
 * The handler map a declared operation set requires — the `satisfies Impl`
 * seam the SDL adopter asked for (#695), which is what makes the declaration
 * BINDING rather than decorative.
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
  // A derived operation has no handler to write (#1773): the platform supplies it.
  [K in keyof Ops as Ops[K] extends { derive: DerivedKind } ? never : K]: Ops[K] extends { output: infer O }
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
 * Every field is optional and none is defaulted here — `order` gets its
 * DECLARED default per operation in `operationInputsOf` (#2001). `listPageQuery` already
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
): Readonly<Record<string, z.ZodType>> {
  const inputs: Record<string, z.ZodType> = {};
  for (const [name, op] of Object.entries(operations)) {
    const decl = op as {
      input?: z.ZodObject<z.ZodRawShape>;
      inputOptional?: boolean;
      paged?: { order?: 'asc' | 'desc' };
    };
    if (decl.paged) {
      // `inputOptional` on a paged read means the FILTERS are optional, not the
      // body — the platform always supplies a page. `.partial()` is what
      // `ImplInput` says (`Partial<z.infer<I>> & PagedInput`), and saying it
      // twice is how the two would come to disagree.
      const filters = decl.input ?? z.object({});
      // #2001: the declared `order` is the default a caller gets by saying nothing — on
      // every door, because every door parses here: the route, MCP, an in-process
      // `invoke`, a seed, a schedule, on either adapter. It used to be read ONLY by the
      // OpenAPI emitter, which advertised `desc` while `ctx.page` served `asc`. The one
      // field that IS defaulted, unlike `limit` below: the declaration states it, so a
      // value present for a caller who never sent it is the truth rather than a lie.
      // An undeclared order stays absent, so a `sortKey` handler's own fallback still
      // decides there.
      const declaredOrder = decl.paged.order;
      const paging =
        declaredOrder === undefined
          ? pagedInputFields
          : { ...pagedInputFields, order: pagedInputFields.order.default(declaredOrder) };
      const shape = (decl.inputOptional ? filters.partial() : filters).extend(paging);
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
  // #119: the declared surface travels with the schemas, so the host DERIVES each operation's
  // target from the same declaration it parses with — a module cannot hand it a partial map.
  // Both are frozen, and the pair is recorded where only this module can write
  // (`declaredSurfaceOf`), so neither can be edited or imitated after the fact.
  const targets = operationTargetsOf(operations);
  for (const target of Object.values(targets)) Object.freeze(target);
  DECLARED_SURFACES.set(
    inputs,
    Object.freeze({ operations: Object.freeze(Object.keys(operations)), targets: Object.freeze(targets) }),
  );
  return Object.freeze(inputs);
}

/**
 * What `operationInputsOf` records for each map it builds (#119): every declared operation's name
 * and the entity each addresses by id. Deep-frozen.
 */
export interface DeclaredOperationSurface {
  readonly operations: readonly string[];
  readonly targets: Readonly<Record<string, Readonly<OperationTarget>>>;
}

/**
 * Every map `operationInputsOf` built, and the surface it was built from (#119). Module-private
 * and keyed by the map's identity: no property on the map carries the surface, so a copy, a spread
 * or a hand-built map has none, and nothing outside this module can add one.
 */
const DECLARED_SURFACES = new WeakMap<object, DeclaredOperationSurface>();

/**
 * The declared surface an `operationInputs` map was derived from — `undefined` for any map
 * `operationInputsOf` did not itself return (a hand-built one, a copy, or one built by a second
 * copy of this package, whose record this one cannot read).
 */
export function declaredSurfaceOf(operationInputs: object | undefined): DeclaredOperationSurface | undefined {
  return operationInputs === undefined ? undefined : DECLARED_SURFACES.get(operationInputs);
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
    assertPatchInputs(out);
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
