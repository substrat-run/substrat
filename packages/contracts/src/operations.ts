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
type ErasableOf<Entities, O> = O extends { emits: { entity: infer N } }
  ? N extends keyof Entities
    ? Entities[N] extends { erasable: readonly (infer F)[] }
      ? F & string
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
type OpAuthority<O, PermKey extends string> = O extends { narrows: unknown }
  ? { readonly narrows: { readonly reason: string }; readonly permission?: never }
  : { readonly permission: PermKey; readonly narrows?: never };

/**
 * The per-operation constraint, self-referential in `O`.
 *
 * Each operation is checked against ITS OWN declared input and output rather
 * than an erased supertype. Written the obvious way every check below compiles
 * clean and enforces nothing — see `test/operations.test.ts`, which exists to
 * prove they still bite.
 */
type OperationShape<O, Entities, PermKey extends string> = {
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
    /** The entity the event is about — a declared entity. */
    readonly entity: keyof Entities & string;
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
    readonly payload?: readonly Exclude<OutputKeys<O>, ErasableOf<Entities, O>>[];
  } & PiiShape<O, OutputKeys<O>>;
  /**
   * Per-field permission on the projection: omission, not denial. The caller
   * still gets the row, without the fields they may not see.
   */
  readonly gates?: { readonly [F in OutputKeys<O>]?: PermKey };
} & OpAuthority<O, PermKey>;

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
>(_entities: Entities, _permissions: Perms) {
  return <
    const Ops extends {
      readonly [K in keyof Ops]: OperationShape<Ops[K], Entities, Perms[number]>;
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
    return typeof permission === 'string' ? [permission] : [];
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
