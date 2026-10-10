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
 * The brand is type-only. The host reads the same plain object it always did.
 */
import {
  operationConcurrencyOf,
  operationIdempotencyOptOutsOf,
  operationInputsOf,
  type OperationImpl,
} from '@substrat-run/contracts';
import type { OperationContext, OperationHandler } from './scope-host.js';

declare const bound: unique symbol;

/** name → handler, as the host reads it. */
export type HandlerMap = Readonly<Record<string, OperationHandler<never, unknown>>>;

/**
 * Everything a module hands the host about its operations, in one value only `operationsFor` and
 * `undeclaredOperations` produce — never written by hand.
 *
 * The handlers and the three maps derived from their declaration travel together, so a
 * registration cannot carry one without the others or pair a handler map with another
 * declaration's schemas. `H` keeps each handler's own type, so a module can still call one.
 */
export interface BoundOperations<H = HandlerMap> {
  readonly [bound]: true;
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
}

type IsAny<T> = 0 extends 1 & T ? true : false;

/** The keys whose handler type was erased at the map — `as never`, `as any`. */
type ErasedKeys<H> = {
  [K in keyof H]-?: IsAny<H[K]> extends true ? K : [H[K]] extends [never] ? K : never;
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
    handlers: H & Exact<Ops, H>,
  ): { operations: BoundOperations<H> } => ({
    operations: {
      handlers,
      inputs: operationInputsOf(declaration),
      concurrency: operationConcurrencyOf(declaration),
      idempotencyOptOuts: operationIdempotencyOptOutsOf(declaration),
    } as unknown as BoundOperations<H>,
  });
}

/**
 * The declared exception: a module whose operations have no declaration to bind to, so the
 * host parses nothing for them. The reason is required, and is what a reviewer reads.
 */
export function undeclaredOperations(reason: string, handlers: HandlerMap): { operations: BoundOperations } {
  if (reason.trim() === '') throw new Error('undeclaredOperations: give the reason this module declares no operations');
  return { operations: { handlers } as unknown as BoundOperations };
}
