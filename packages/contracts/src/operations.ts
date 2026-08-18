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
import { z } from 'zod';
import type { EntityDef } from './model.js';

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
  /** The entity type the check narrows to — this module's, or a composed engine's. */
  readonly entity:
    | (keyof Entities & string)
    | (Engines extends readonly (infer R)[] ? (R extends Record<string, EntityDef> ? keyof R & string : never) : never);
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
    readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    readonly path: CheckedPath<O>;
  };
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
     */
    readonly entity:
      | (keyof Entities & string)
      | (Engines extends readonly (infer R)[] ? (R extends Record<string, EntityDef> ? keyof R & string : never) : never);
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
  ): Ops => operations;
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
      ? (ctx: Ctx, input: ImplInput<Ops[K]>) => z.infer<O> | Promise<z.infer<O>>
      : never
    : never;
};

/** No declared `input` means the handler takes `undefined`. */
type ImplInput<O> = O extends { input: infer I }
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
 * One engine operation, given a place in THIS vertical's HTTP surface.
 *
 * An engine declares no `http`, and should not: it is entity-agnostic and does
 * not own a URL shape. Two verticals composing `workorder` legitimately disagree
 * about whether it lives at `/workorders` or `/repairs`. So the path is the
 * vertical's to decide — but it was previously undeclarable, which is why a
 * composing vertical hand-wrote most of its route table (Callout: 17 of 27).
 *
 * `input` and `output` are IMPORTED from the engine, never retyped —
 * `createWorkOrderInput` and `workOrder` are exported for exactly this.
 */
type EngineRouteShape<O> = {
  /** One line, imperative — what invoking this does. Feeds the API document. */
  readonly summary: string;
  /** The engine's own input schema. Omitted means the operation takes no body. */
  readonly input?: z.ZodObject<z.ZodRawShape>;
  /** The engine's own published return shape, where the engine exports one. */
  readonly output?: z.ZodType;
  readonly http: {
    readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    readonly path: CheckedPath<O>;
  };
};

/**
 * Declare where a composed engine's operations live in this vertical's API.
 *
 * ```ts
 * export const engineRoutes = defineEngineRoutes({
 *   'workorder/get': {
 *     summary: 'One work order',
 *     input: getWorkOrderInput,
 *     output: workOrder,
 *     http: { method: 'GET', path: '/workorders/{orderId}' },
 *   },
 * });
 * ```
 *
 * Every `{var}` is checked against the engine's own input schema, so a path
 * naming a field the engine does not accept is a compile error — the defect
 * class that hand-written routes produced silently.
 *
 * **The operation NAME is not checked here, and cannot be.** `ModuleRegistration`
 * types its operations as `Record<string, OperationHandler>`, so the keys are
 * erased before a vertical can see them. Pass `knownOperations` to
 * `mountOperations` and a typo fails at mount instead of as a 404 at request
 * time; declaring engine operations (#707) would move it earlier still.
 */
export function defineEngineRoutes<
  const R extends { readonly [K in keyof R]: EngineRouteShape<R[K]> },
>(routes: R): R {
  return routes;
}
