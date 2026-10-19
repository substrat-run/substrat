/**
 * The repo's preload that makes an unchecked operation a FAILURE in every node suite (#2387).
 *
 * Both scope hosts count the `ctx.check` calls of each invocation, and an operation that declares
 * a `permission` but returns without asking writes a `warn` line (`packages/kernel/src/
 * check-tally.ts`). In production that line is all it does. Here it also refuses: this file sets
 * the registered flag the kernel reads, so the operation throws `UncheckedOperation` after the
 * line is written and rolls back — which makes every scenario suite the gate for checklist S2's
 * one case no declaration can show, without a deployed scope failing over a diagnostic.
 *
 * `--require`d beside the LIKE and SQL-limit preloads, by the root `pnpm test`, CI's test step and
 * `pnpm test:affected`; `tools/vitest/preloads.test.mjs` refuses a preload missing from any of the
 * three, so this one cannot be dropped from one of them quietly. A bare `pnpm --filter … test`
 * does not have it, exactly as it does not have the other two.
 *
 * Plain CommonJS with no requires: it sets one global and loads nothing, so it costs a process
 * nothing that never opens a scope.
 */
'use strict';

globalThis[Symbol.for('substrat.refuseUncheckedOperations')] = true;
