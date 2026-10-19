---
"@substrat-run/kernel": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/contract-tests": minor
---

Both scope hosts now count the `ctx.check` calls each invocation makes. An operation that declares a `permission` and returns without calling `ctx.check` writes a `warn` line through `ctx.log` (template `operation completed without a permission check`, field `finding: 'unchecked-operation'`), stamped with the tenant, scope, operation and invocation like every other line. The invocation itself is unchanged: no error and no rollback. A refused, caught or throwing check counts, and so does one made inside a helper or a kernel verb. Derived handlers, `narrows` walks and modules bound with `undeclaredOperations` are not held to a check. An operation that deliberately checks nothing declares `narrows: { reason, checks: [], unchecked: true }`.

A node test run can make it a failure by setting the registered `globalThis` flag named by `REFUSE_UNCHECKED_OPERATIONS_KEY`: the operation then throws `UncheckedOperation` after the line and rolls back. The kernel exports `countChecks`, `noteUncheckedCompletion`, `checkHeldOperationsOf`, `UncheckedOperation`, `REFUSE_UNCHECKED_OPERATIONS_KEY`, `UNCHECKED_OPERATION_TEMPLATE` and `UNCHECKED_OPERATION_FINDING`. `@substrat-run/contract-tests` adds `checkTallyContractSuite`, which every adapter runs.
