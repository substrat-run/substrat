/**
 * `@substrat-run/kernel/testing` — the test seam around the operation binder (#1835).
 *
 * A contract suite that proves what the HOST refuses has to hand it maps no binder would make:
 * a schema naming an unbound operation, an `inputs` map that is not the one `operationInputsOf`
 * returned, a forged trash surface. This is the one way to build such a `BoundOperations`.
 *
 * It is a subpath, never the index, and boundary-lint R2 refuses its import from module code:
 * a module that could reach it could pair its handlers with any schemas it liked.
 */
import { BoundOperations, MINT, type HandlerMap } from './module-operations.js';

export function forgeBoundOperationsForTest(
  handlers: HandlerMap,
  derived: {
    inputs?: BoundOperations['inputs'];
    concurrency?: BoundOperations['concurrency'];
    idempotencyOptOuts?: BoundOperations['idempotencyOptOuts'];
  },
): BoundOperations {
  return new BoundOperations(MINT, handlers, derived);
}
