/**
 * The handler map a module registers, joined to its declaration by a type (#1835).
 *
 * `ModuleRegistration.operations` used to be a `Record<string, OperationHandler<never, unknown>>`,
 * which accepts any handler under any name, and the schemas the host parses with were a second
 * field nothing tied to it. What held the two to the module's declared operations was a text
 * rule looking for a `satisfies` clause — and a `satisfies` is invisible to every test, so
 * deleting one compiled and passed exactly like keeping it (#959).
 *
 * Now the field takes `BoundOperations` — the handlers and the maps derived from their
 * declaration, as one value — which only two functions produce:
 *
 * - `operationsFor(declaration)(handlers)` — the handlers are held EXACTLY to the declaration
 *   (a missing, extra, mistyped or cast entry is a compile error), and the input schemas, the
 *   concurrency map and the idempotency opt-outs come from the same object, so "the same
 *   declaration" holds by construction rather than by a reviewer comparing two identifiers.
 * - `undeclaredOperations(reason, handlers)` — the exception, for a module that declares no
 *   operation surface at all, and it has to say why.
 *
 * A plain object literal no longer compiles, which is the point: binding a declared module by
 * hand is not a shape that can be written by accident. What the type cannot see is an `as`
 * applied to the whole map, since `never` and `any` are assignable to anything; boundary-lint
 * **R11** refuses that at the registration.
 *
 * The brand is an ES-private field, so it holds at run time as well: both adapters refuse an
 * `operations` value the binder did not make (`assertBoundOperations`).
 */
import {
  derivationPlanOf,
  operationConcurrencyOf,
  operationIdempotencyOptOutsOf,
  operationInputsOf,
  type DerivedKeys,
  type OperationImpl,
} from '@substrat-run/contracts';
import { derivedHandler } from './derived-handlers.js';
import type { OperationContext, OperationHandler } from './scope-host.js';

/** name → handler, as the host reads it. */
export type HandlerMap = Readonly<Record<string, OperationHandler<never, unknown>>>;

/** The derived maps, as the constructor takes them. */
interface DerivedMaps {
  readonly inputs?: Readonly<Record<string, { parse(value: unknown): unknown }>>;
  readonly concurrency?: Readonly<Record<string, { entity: string; idFrom: string }>>;
  readonly idempotencyOptOuts?: readonly string[];
}

/**
 * The key to the constructor. Module-private to the kernel: `operationsFor`,
 * `undeclaredOperations` and the test seam in `./testing` hold it, and nothing a module can
 * import does. Exported from this file only so `testing.ts` can reach it — never from the index.
 */
export const MINT: unique symbol = Symbol('BoundOperations.mint');

/**
 * The run-time mark, a REGISTERED symbol held as a non-enumerable own property. Registered, so a
 * second copy of the kernel in one process — a bundle that resolved two, or a test that reset its
 * module graph — recognises the binder's value; non-enumerable, so a spread, `Object.assign` or a
 * structured clone leaves it behind, exactly as they leave the `#bound` field behind at compile time.
 */
const BRAND = Symbol.for('substrat.kernel.boundOperations');

/**
 * Everything a module hands the host about its operations, in one value only `operationsFor` and
 * `undeclaredOperations` produce — never written by hand.
 *
 * The handlers and the three maps derived from their declaration travel together, so a
 * registration cannot carry one without the others or pair a handler map with another
 * declaration's schemas. `H` keeps each handler's own type, so a module can still call one.
 *
 * **A class with an ES-private brand, so a copy is not one** (#2155 review). A symbol-keyed brand
 * survives an object spread, so `{ ...bound, inputs: undefined }` type-checked as the bound value
 * with its schemas gone. A `#private` field is nominal to TypeScript and absent from any copy, so
 * that spread does not compile. At run time the adapters ask for `BRAND` instead, which a spread,
 * `Object.assign` or a literal does not carry either, so they refuse such a copy at registration
 * too. (The field cannot be the run-time check: it is private to one copy of this class, and a
 * process can hold two — a test that resets its modules does, and #2155's suite found one.)
 */
export class BoundOperations<H = HandlerMap> {
  readonly #bound = true;
  /** name → handler. */
  readonly handlers: H & HandlerMap;
  /**
   * name → the schema the host parses an invocation's input against, before the guards and the
   * handler (#893). The map `operationInputsOf` returned, as returned: it also carries the
   * declared surface the host derives its trash refusal from (#119). Absent for a module that
   * declares no operations, where nothing is parsed.
   */
  readonly inputs?: Readonly<Record<string, { parse(value: unknown): unknown }>>;
  /** name → the entity whose version an `If-Match` on that operation is compared against (#129). */
  readonly concurrency?: Readonly<Record<string, { entity: string; idFrom: string }>>;
  /** The operations that declared `idempotency: false`, and so refuse an `Idempotency-Key` (#116). */
  readonly idempotencyOptOuts?: readonly string[];

  constructor(mint: typeof MINT, handlers: H & HandlerMap, derived: DerivedMaps = {}) {
    if (mint !== MINT) {
      throw new Error('BoundOperations: made by operationsFor or undeclaredOperations, never constructed directly');
    }
    Object.defineProperty(this, BRAND, { value: true });
    // Frozen, all the way to what the adapters read (#2155 review): `readonly` does not stop
    // `Object.assign(bound, { inputs: undefined })`, and an edit in place keeps the brand, so the
    // value would register with its schemas gone or a handler added that nothing parses for.
    // Frozen, each of those throws at module load — ES modules are strict.
    this.handlers = Object.freeze({ ...handlers });
    // In place, not copied: the map `operationInputsOf` returned is the key its declared surface
    // is recorded under (#119), and it arrives frozen already. A test seam's map gets the same.
    if (derived.inputs !== undefined) this.inputs = Object.freeze(derived.inputs);
    if (derived.concurrency !== undefined) {
      this.concurrency = Object.freeze(
        Object.fromEntries(Object.entries(derived.concurrency).map(([name, at]) => [name, Object.freeze({ ...at })])),
      );
    }
    if (derived.idempotencyOptOuts !== undefined) this.idempotencyOptOuts = Object.freeze([...derived.idempotencyOptOuts]);
    Object.freeze(this);
  }

  /** Was this value made by the binder — not a copy, a spread or a literal shaped like one? */
  static is(value: unknown): value is BoundOperations {
    return typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, BRAND);
  }
}

/**
 * The adapters' registration check: a module's `operations` is a value the binder made, or the
 * module does not register. A copy has no brand; nor does one made by a second copy of the kernel,
 * which is the same refusal for the same reason — its maps are not the ones this host can trust.
 */
export function assertBoundOperations(moduleId: string, operations: unknown): asserts operations is BoundOperations | undefined {
  if (operations === undefined || BoundOperations.is(operations)) return;
  throw new Error(
    `${moduleId}: \`operations\` is not a value operationsFor or undeclaredOperations made — a copy, a spread ` +
      'or a literal shaped like one carries maps nothing bound to the handlers (or the module was built ' +
      'against a second copy of @substrat-run/kernel).\n  Remedy: `...operationsFor(ops)({ … })`, as returned.',
  );
}

type IsAny<T> = 0 extends 1 & T ? true : false;

/** Does this function type take or return `any` anywhere a handler's contract lives? */
type TypedLoosely<F> = F extends (...args: infer P) => infer R
  ? true extends IsAny<R> | IsAny<Awaited<R>> | { [I in keyof P]: IsAny<P[I]> }[number]
    ? true
    : false
  : false;

/**
 * The keys whose handler type was erased at the map: an entry cast `as never` or `as any`, or one
 * whose parameters or return are `any` — `addOp as (...a: any[]) => any`, or an untyped
 * `(c: any, i: any) => i`, which `OperationImpl` accepts because `any` fits every slot.
 */
type ErasedKeys<H> = {
  [K in keyof H]-?: IsAny<H[K]> extends true
    ? K
    : [H[K]] extends [never]
      ? K
      : TypedLoosely<H[K]> extends true
        ? K
        : never;
}[keyof H];

/**
 * What the handler map must also be, beyond `OperationImpl`: no key the declaration does not
 * name, and no entry whose type was erased. An erased entry is assignable to any slot, so it
 * cannot be refused AT the slot; it is refused by demanding a property the literal does not have.
 */
type Exact<Ops, H> = { readonly [K in Exclude<keyof H, keyof Ops>]: never } & ([ErasedKeys<H>] extends [never]
  ? unknown
  : { readonly 'a handler type was erased with a cast': ErasedKeys<H> });

/**
 * Bind a module's handlers to its declared operations.
 *
 * ```ts
 * export const todoModule: ModuleRegistration = {
 *   manifest: todoManifest,
 *   migrations: todoMigrations,
 *   ...operationsFor(todoOperations)({
 *     'todo/add': addOp,
 *     …
 *   }),
 * };
 * ```
 *
 * Curried, like `consumersFor`, so the declaration is inferred before the handlers are checked
 * against it.
 */
export function operationsFor<const Ops extends Record<string, object>>(declaration: Ops) {
  return <const H extends OperationImpl<Ops, OperationContext>>(
    handlers: H & Exact<Omit<Ops, DerivedKeys<Ops>>, H>,
  ): { operations: BoundOperations<H> } => ({
    operations: new BoundOperations<H>(MINT, withDerivedHandlers(declaration, handlers), {
      inputs: operationInputsOf(declaration),
      concurrency: operationConcurrencyOf(declaration),
      idempotencyOptOuts: operationIdempotencyOptOutsOf(declaration),
    }),
  });
}

/**
 * The authored handlers, plus one written from each `derive` declaration's plan (#1773).
 *
 * The type already leaves a derived key out of the map it accepts; this is the runtime half, for
 * the map that reached here through a cast. A handler handed to a derived operation is refused
 * rather than preferred, since a hand-written one standing in silently for the derived one is the
 * restatement `derive` exists to remove.
 */
function withDerivedHandlers<H>(declaration: Readonly<Record<string, object>>, handlers: H): H & HandlerMap {
  const out: Record<string, OperationHandler<never, unknown>> = { ...(handlers as HandlerMap) };
  for (const [name, op] of Object.entries(declaration)) {
    if ((op as { derive?: unknown }).derive === undefined) continue;
    if (Object.hasOwn(out, name)) {
      throw new Error(
        `operationsFor: '${name}' is derived (\`derive\`) and must not be handed a handler — delete it, ` +
          'or declare `authored` in place of `derive`',
      );
    }
    const plan = derivationPlanOf(op);
    if (plan === undefined) {
      throw new Error(
        `operationsFor: '${name}' declares \`derive\`, but its declaration did not pass through ` +
          '`defineOperations`, which is what decides whether it is derivable',
      );
    }
    out[name] = derivedHandler(plan);
  }
  // The authored handlers keep their types; the derived ones are keys `H` never named.
  return out as H & HandlerMap;
}

/**
 * The declared exception: a module whose operations have no declaration to bind to, so the
 * host parses nothing for them. The reason is required, and is what a reviewer reads.
 */
export function undeclaredOperations(reason: string, handlers: HandlerMap): { operations: BoundOperations } {
  if (reason.trim() === '') throw new Error('undeclaredOperations: give the reason this module declares no operations');
  return { operations: new BoundOperations(MINT, handlers) };
}
