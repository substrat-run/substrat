import { undeclaredOperations, type BoundOperations, type HandlerMap } from '@substrat-run/kernel';

/** The maps a registration derives from a declaration, as a fixture may hand them over raw. */
export interface RawDerivedMaps {
  inputs?: BoundOperations['inputs'];
  concurrency?: BoundOperations['concurrency'];
  idempotencyOptOuts?: BoundOperations['idempotencyOptOuts'];
}

/**
 * A fixture's operations, registered without binding them to a declaration (#1835) — the TEST
 * SEAM around `operationsFor`, and the only one.
 *
 * The suites drive the host with modules built for one assertion each, so most have no declared
 * surface: `testOperations(handlers)` is `undeclaredOperations` with the reason stated once.
 *
 * A few prove what the HOST refuses when the derived maps are wrong — a schema or a precondition
 * naming an unbound operation, an `operationInputs` that is not the map `operationInputsOf`
 * returned, a forged trash surface — or need maps over handlers whose types they erase on
 * purpose. Those pass `derived`, and get a `BoundOperations` no binder made. That is exactly the
 * value a module cannot build, which is why this lives here and never in the kernel's index.
 */
export function testOperations(handlers: HandlerMap, derived?: RawDerivedMaps): { operations: BoundOperations } {
  if (!derived) return undeclaredOperations('a contract-test fixture, built to drive the host rather than declared', handlers);
  return { operations: { handlers, ...derived } as unknown as BoundOperations };
}
