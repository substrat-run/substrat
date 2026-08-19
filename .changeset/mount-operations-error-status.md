---
'@substrat-run/vertical-host': minor
---

`mountOperations` answers a refused permission with 403, and hands the vertical
the seam it was missing.

Every failure the derived mount could produce came back as `500 Internal Server
Error`. A permission denial — the most common non-success outcome in a
permissioned system, and one the kernel raises as a typed `PermissionDenied` —
was indistinguishable from a crash, and so was an input that failed to parse
(#791). Only the success case was right.

The failure is worse than a wrong number: a client that reads `ok` off every
reply cannot find it on a raw result at 200 either, so it falls back to
`res.ok` — true — and renders empty screens successfully, on every endpoint, with
no error anywhere.

**The kernel's own vocabulary is now mapped, and nothing else is.** A refused
permission is 403, a `ZodError` is 400, a body that is not JSON is 400, an
`HTTPException` keeps the status it already chose (so `resolveStub` refusing an
anonymous call is still 401), and a Durable Object / runtime fault is 502 (#559).
Anything else is **re-thrown untouched**, so a vertical's own `app.onError` still
receives its own domain errors exactly as before and keeps mapping them.

What is mapped is re-thrown as an `HTTPException`, not answered directly: this
decides the *status*, and an app that owns an error envelope goes on owning the
*body*. `mountPlatformSurface`'s handler already reads the status and wraps the
message, so a worker mounting both surfaces gets one envelope at the right code.

**Two new options for a vertical that wants the shape too.** `respond(c, result,
operation)` decides the success response — the mount had already decided that
much while leaving failures to the vertical, so an adopting vertical's envelope
ended up defined in two places in two vocabularies. It is also the honest home
for per-request work between the invoke and the response (stripping a field the
caller may not see, relaying a credential, sending mail); the alternative
verticals were reaching for is a `resolveStub` whose `invoke` returns an envelope
instead of the operation's result, which makes `ScopeStub` a lie. `onError(c,
error, operation)` decides the failure response, and may return `undefined` to
fall through to the mapping above.

Both are optional and both default to today's behaviour, so the only change to an
existing mount is that statuses stopped lying.

The classification itself moved into one module shared with
`mountPlatformSurface`, which has answered the same question since #510 — two
surfaces on the same worker disagreeing about the same kernel errors was one
vocabulary too many. It is exported as `classifyError` for a vertical that wants
to reuse it in a handler of its own.
