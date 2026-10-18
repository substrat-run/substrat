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
    checks?: BoundOperations['checks'];
  },
): BoundOperations {
  // #2384: a forged value declares only the checks it is handed, so `PERMISSIONS.md` reads its
  // other operations as "not declared" — never as bound by an older kernel, which re-emitting
  // cannot fix.
  return new BoundOperations(MINT, handlers, { checks: {}, ...derived });
}

/** How many migration set digests this isolate computed (#2349): a scope with nothing pending computes none. */
export { migrationSetDigestComputations } from './migration-digest.js';
