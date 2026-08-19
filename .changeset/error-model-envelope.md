---
'@substrat-run/contracts': minor
'@substrat-run/adapter-cloudflare': minor
---

The error model, phase 3: a failure crosses the ScopeDO boundary as a value, so the code
finally survives the hop.

Phase 2 measured what a throw actually carries across that boundary and the answer was
"its message, and nothing else" — `name` folded into the message, every own property
dropped. That is why `instanceof PermissionDenied` has been false in production while
being true in every test, and why verticals match error messages with regexes.

So a failure stops being thrown across the boundary and starts being returned across it.
`ScopeDO.invoke` returns `{ result, platformRequests, failure? }`, where `failure` is a
`WireFailure`: name, message, code, extensions, plain JSON. The coordinator rebuilds an
error from it and throws THAT — the envelope is the wire's shape, never the API's, so
every caller above `host.ts` still writes `try`/`catch` exactly as before.

**Opt-in per call, which is what makes it deployable.** The coordinator passes
`failureEnvelope: true`. A ScopeDO instance still running older code ignores an unknown
trailing argument and throws exactly as it always did, which the coordinator still
handles; and without the flag a new DO throws too, so the reverse skew cannot silently
turn a failure into a success. There is no flag day and no window where an error reads as
a result.

What it deliberately does not do: the rebuilt error is a `SubstratError` wearing the
original `name`, not an instance of the class that was thrown. Contracts cannot import
the kernel, and reviving arbitrary classes over a wire is a capability nobody should
want. `instanceof PermissionDenied` stays false on this path and always will — it is the
wrong question, and every consumer in the repo asks `errorCodeOf` instead.

Measured, not asserted: the adapter's contract suite now crosses the hop and checks that
the message arrives verbatim, that the code and name arrive with it, and that the result
classifies to the same status a same-isolate throw would.

The compat path is exercised too, and that one nearly shipped untested. Every test goes
through the coordinator, which always asks for the envelope — so the flag-absent branch
was reached by nothing, and the argument this change rests on for deploy safety was an
assertion about code no test ran. Three tests now call the DO directly the way an older
coordinator would: the legacy path still rejects with its message intact, a denial is
never handed back as a resolved result, and the envelope appears only when asked for.

Still throwing across the hop, and so still losing their structure: `attachmentAdd`,
`attachmentList`, `attachmentAuthorize`, `attachmentRemove`, `introspectQuery`. Same
pattern, mechanical, much lower traffic.
