/**
 * The handler map a module registers, joined to its declaration by a type (#1835).
 *
 * `ModuleRegistration.operations` used to be a `Record<string, OperationHandler<never, unknown>>`,
 * which accepts any handler under any name, and the schemas the host parses with were a second
 * field nothing tied to it. What held the two to the module's declared operations was a text
 * rule looking for a `satisfies` clause — and a `satisfies` is invisible to every test, so
 * deleting one compiled and passed exactly like keeping it (#959).
 *
 * Now the field takes `BoundOperations`, which only two functions produce:
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

/** A handler map produced by `operationsFor` or `undeclaredOperations` — never written by hand. */
export type BoundOperations = HandlerMap & { readonly [bound]: true };

/**
 * What `operationsFor` hands a registration: the map, and everything the host derives from the
 * declaration. `H` keeps each handler's own type, so a module can still call one directly.
 */
export interface DeclaredOperations<H = HandlerMap> {
  operations: BoundOperations & H;
  operationInputs: Readonly<Record<string, { parse(value: unknown): unknown }>>;
  operationConcurrency: Record<string, { entity: string; idFrom: string }>;
  operationIdempotencyOptOuts: readonly string[];
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
  return <const H extends OperationImpl<Ops, OperationContext>>(handlers: H & Exact<Ops, H>): DeclaredOperations<H> => ({
    operations: handlers as unknown as BoundOperations & H,
    operationInputs: operationInputsOf(declaration),
    operationConcurrency: operationConcurrencyOf(declaration),
    operationIdempotencyOptOuts: operationIdempotencyOptOutsOf(declaration),
  });
}

/**
 * The declared exception: a module whose operations have no declaration to bind to, so the
 * host parses nothing for them. The reason is required, and is what a reviewer reads.
 */
export function undeclaredOperations(reason: string, handlers: HandlerMap): { operations: BoundOperations } {
  if (reason.trim() === '') throw new Error('undeclaredOperations: give the reason this module declares no operations');
  return { operations: handlers as BoundOperations };
}
