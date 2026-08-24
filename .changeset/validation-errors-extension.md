---
'@substrat-run/contracts': minor
'@substrat-run/contract-tests': minor
---

contracts: a parse failure carries its fields across the ScopeDO hop

`PROBLEM_EXTENSIONS.validation_failed` has always declared an `errors` member, and
`validationIssuesFrom` has always existed to build it. Nothing populated it on the way
out, so field-level issues survived only as JSON **inside the message string** and every
vertical that wanted them wrote the same `fromZod()` that re-parses that string (#831).

**#893 is what made this load-bearing rather than cosmetic.** The host now parses a
declared operation input at the scope door, so the two adapters lose the answer
differently:

- under `adapter-sqlite` the refusal throws in-process and the `ZodError` arrives with
  `issues` intact;
- under `adapter-cloudflare` it is raised *inside* the ScopeDO and crosses the hop, where
  a throw carries only its message. `toWireFailure` copied `SubstratError.extensions` —
  which a `ZodError` does not have — so the field list was dropped at the one seam it had
  to cross.

Structured in a scenario test and bare in production is the worst of the two available
failures, and it is the shape that hides: the code was right (`validation_failed`), the
status was right (400), and only the half a client actually acts on was missing.

- **`toWireFailure` maps `issues` onto the declared `errors` extension**, so
  `fromWireFailure` → `toProblem` round-trips a parse failure with its fields on both
  substrates. A throw that already carries `errors` is left alone.
- **`toProblem` reads a parse failure by SHAPE, not `instanceof`** — the doctrine
  `errorCodeOf` and `vertical-host`'s `isParseFailure` already follow, for the reason
  this module states about two copies of a library in one build. `instanceof z.ZodError`
  silently produced a fieldless body for a duplicate zod copy.
- **A parse failure gets the canonical `detail`** on both paths rather than the throw's
  own message. A raw `ZodError` stringifies its whole issue list into `message`; echoing
  that beside a parsed `errors` array publishes the same thing twice, in exactly the shape
  this change exists to stop clients re-parsing.

  **Scoped to parse failures, and the `errors` list is what identifies one.**
  `validation_failed` is also raised semantically — `endDate precedes startDate`
  (`engines/absence`), `invalid interval` (`engines/booking`), `at most one party may
  sign as primary` (`engines/protocol`) — where the sentence *is* the information and no
  field list exists to put in its place. Those keep their own message, unchanged, and a
  test pins it: a canonical detail applied to all of `validation_failed` would have
  deleted seventeen useful messages across four engines to standardise a body that had
  nothing else to say.

**The test is in `inputParseContractSuite`, not only in `contracts`.** A round-trip unit
test passes on either adapter; it is the suite that already runs on both which can say the
two agree. Checked by neutralising the fix: the new case is red on `adapter-cloudflare`
and green on `adapter-sqlite` — the asymmetry, reproduced before it was closed.

`CODE_BY_ERROR_NAME`'s comment recorded the loss as accepted (*"a parse failure crossing
the hop loses its `issues` array"*); it now records why the `ZodError` row still earns its
place — a prototype-less arrival, a structured clone, the legacy pre-envelope RPC path —
rather than a loss that no longer happens.

Not in scope: transports emitting `problem+json`. `toProblem` still has no production
caller, `mountOperations` still decides status and not shape by design, and every vertical
still hand-rolls its own `onError`. That is phase 4 of the error-model rollout
(`docs/rfc/error-model.md` §5) and its own reviewable diff. What changes here is that a
caller reaching for `toProblem` now gets the fields on every substrate instead of one.
