---
'@substrat-run/boundary-lint': minor
---

Catching an engine error outside `ctx.atomic` is now a lint error

#770 landed `ctx.atomic`, so a vertical *can* catch an engine error safely. It only moved
the line: **outside** an atomic, a bare `catch` around an engine call is still exactly the
#770 bug — you are holding the engine's partial writes, the rows its invariants were
protecting, and you will commit them. The repo had traded one convention for a narrower
one, still enforced by review.

`R7` is the mechanism (#786):

> In module code, a `catch` whose `try` block calls an imported engine in-scope function,
> and which is not lexically inside a `ctx.atomic` callback, is a violation.

```ts
try {
  await completeWorkOrder(ctx, { orderId, billable });   // ✗ R7
} catch {
  return { ok: false };                                  // the engine's rows just committed
}

try {
  await ctx.atomic(() => completeWorkOrder(ctx, { orderId, billable }));  // ✓
} catch {
  // rows, events, links, grants and platform intents all gone; your writes survive
}
```

Two shapes do not swallow, and both pass: **`try`/`finally` with no `catch`**, and a catch
that **always rethrows** (`catch (e) { log(e); throw e }`, wrapped or not) — the operation
still fails, so the whole transaction rolls back either way. A `throw` nested inside an `if`
does not count: that catch has a path that swallows, and that path is the bug.

There is **no** `boundary-lint-allow R7` hatch. Unlike R5's one-time extraction handoff or
R6's real-clock JWT, there is no legitimate reason to swallow an engine error unprotected,
so a hatch would only ever be used to silence the rule.

**It is R7, not the R6 the design note proposed.** Rule numbers are claimed when they ship;
the no-clock rule (#812) landed first and took `R6`. Two rules sharing a number would be
worse than a stale proposal.

**No new dependency.** R7 needs two things R1–R6 did not — which identifiers are bound to
an engine import (aliases and namespace imports included), and whether a call sits lexically
inside a `ctx.atomic` callback — and neither needs a type checker. One offset-preserving
mask of comments, string bodies and regex literals makes brace matching exact, and the pass
runs only on files that import an `@substrat-run/engine-*` package at all. `typescript` in
`dependencies` would have been ~20MB in a package that has none, installed into every
scaffolded vertical, to answer scanner questions.

It under-fires on purpose (a rule that misfires gets suppressed wholesale): an engine call
moved into a local helper is invisible to it, and a conditional rethrow as the catch's last
statement reads as a rethrow. Widening is fixtures, not a redesign.
