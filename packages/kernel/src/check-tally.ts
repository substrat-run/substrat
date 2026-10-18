/**
 * Did the operation ask? (#2387)
 *
 * Every operation checks a permission: its first line is `assertAllowed(await ctx.check(PERM))`.
 * The gates around that rule read declarations — `lint:permissions` the surface,
 * `entityCheckConformanceSuite` an operation that declares `{ key, entity, idFrom }`. None of them
 * sees an operation that declares a bare scope-wide key and whose handler checks nothing, because
 * no declaration tells it apart from a correct one, and a static read of the handler cannot
 * follow the check into the helper it usually delegates to.
 *
 * The host can see it directly. It builds one context per invocation, and every check goes
 * through that context's `check`. So each adapter counts the calls on it ({@link countChecks}),
 * and when the handler returns having made none, the host writes a line saying so
 * ({@link noteUncheckedCompletion}).
 *
 * ## What counts as a check
 *
 * A CALL, not a pass. A refused check counts, so does one the handler caught, and so does one
 * that threw (a malformed key): each is the operation asking, which is the whole question. A
 * check made inside a helper, an engine function or a kernel verb (`ctx.grant` re-checks the
 * caller's own decision, `ctx.archive` checks the declared key) counts too, because it went
 * through the same `ctx.check`. So does a check the host made on the operation's behalf before
 * the handler (the trashed-target refusal, a guard): that is the declared key on the declared
 * entity, asked for this caller.
 *
 * The tally is the context's, and a context belongs to one invocation, so two invocations in one
 * request are counted apart.
 *
 * ## Which operations are held to it
 *
 * Those that declare a `permission` and whose handler is authored (`checkHeldOperationsOf`): a
 * declared key is a promise that the handler asks for it. Left out, each for a reason the
 * declaration states:
 *
 * - a **derived** handler (#1773) — the kernel wrote it from the declaration, check included;
 * - a **`narrows`** walk — it checks row by row, so a walk over nothing asks nothing and is right
 *   to. `narrows: { reason, checks: [], unchecked: true }` is the one way to declare an operation
 *   that checks nothing at all; the reason is required and the conformance receipt lists it;
 * - a module bound with **`undeclaredOperations`** — it declares no key, so it promised none.
 *
 * ## Recorded, and refused only where a test asks
 *
 * The line is a `warn` through the context's own `ctx.log`, so it carries the tenant, scope,
 * operation and invocation every other line does and lands wherever the host sends them. Its
 * template is a constant, so every such line groups into one pattern. In production that is all
 * it does: no error, no rollback.
 *
 * A node test run can turn it into a refusal: `tools/vitest/unchecked-operations.cjs`, preloaded
 * by the root `pnpm test` and CI's test step beside the LIKE and SQL-limit preloads, sets
 * {@link REFUSE_UNCHECKED_OPERATIONS_KEY}, and the operation then throws {@link UncheckedOperation}
 * after the line is written, so it rolls back like any other failure. That makes every scenario
 * suite the gate, without a production scope failing over a diagnostic.
 */
import type { OperationContext } from './scope-host.js';

/** How many checks one invocation's context has been asked for. */
export interface CheckTally {
  calls: number;
}

/**
 * The context's `check`, counted. The count moves BEFORE the check runs, so a check that throws
 * or is refused is still one the operation made.
 */
export function countChecks(check: OperationContext['check'], tally: CheckTally): OperationContext['check'] {
  return (permission, entity) => {
    tally.calls += 1;
    return check(permission, entity);
  };
}

/** The template of the line — constant, so every one of them is the same pattern. */
export const UNCHECKED_OPERATION_TEMPLATE = 'operation completed without a permission check';

/** The `finding` field on that line, for a reader filtering on fields rather than templates. */
export const UNCHECKED_OPERATION_FINDING = 'unchecked-operation';

/**
 * The registered key a test run sets on `globalThis` to have an unchecked completion refused
 * instead of only recorded. Registered, so the copy of the kernel an adapter bundled reads the
 * flag the preload set.
 */
export const REFUSE_UNCHECKED_OPERATIONS_KEY = 'substrat.refuseUncheckedOperations';

function refusing(): boolean {
  return (globalThis as Record<symbol, unknown>)[Symbol.for(REFUSE_UNCHECKED_OPERATIONS_KEY)] === true;
}

/** An operation held to a check completed without one, under a run that refuses it. */
export class UncheckedOperation extends Error {
  constructor(readonly operation: string) {
    super(
      `${operation} declares a permission but its handler returned without calling ctx.check — ` +
        'check the declared key, or declare `narrows: { reason, checks: [], unchecked: true }` if it ' +
        'deliberately checks nothing',
    );
    this.name = 'UncheckedOperation';
  }
}

/**
 * Called once, right after the handler returns. Writes the line when an operation `held` to a
 * check made none, and throws {@link UncheckedOperation} after it when the run refuses them.
 * Returns whether a line was written.
 */
export function noteUncheckedCompletion(
  ctx: OperationContext,
  operation: string,
  tally: CheckTally,
  held: boolean,
): boolean {
  if (!held || tally.calls > 0) return false;
  ctx.log.warn(UNCHECKED_OPERATION_TEMPLATE, { finding: UNCHECKED_OPERATION_FINDING });
  if (refusing()) throw new UncheckedOperation(operation);
  return true;
}
