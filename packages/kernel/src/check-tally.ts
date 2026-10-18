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
 * ## Who is not asked
 *
 * - A **derived** handler (#1773): the kernel wrote it from the declaration, check included. The
 *   bin read (`derive: 'trashed'`) checks row by row and so checks nothing on an empty bin, which
 *   is correct and is why derived handlers are excepted as a class rather than counted.
 * - An operation that **declares it checks nothing** — `narrows: { reason, checks: [],
 *   unchecked: true }`. The reason is required, and the conformance receipt lists the operation,
 *   so the exception is in the model where a reviewer reads it, not in the handler.
 *
 * ## Recorded, not refused
 *
 * The line is a `warn` through the context's own `ctx.log`, so it carries the tenant, scope,
 * operation and invocation every other line does and lands wherever the host sends them. It
 * changes nothing about the invocation: no error, no rollback. Its template is a constant, so
 * every such line groups into one pattern.
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
 * Write the line if the handler returned without asking. Called once, right after the handler
 * returns; `exempt` is whether the operation is one of the two exceptions above. Returns whether
 * a line was written.
 */
export function noteUncheckedCompletion(ctx: OperationContext, tally: CheckTally, exempt: boolean): boolean {
  if (exempt || tally.calls > 0) return false;
  ctx.log.warn(UNCHECKED_OPERATION_TEMPLATE, { finding: UNCHECKED_OPERATION_FINDING });
  return true;
}
