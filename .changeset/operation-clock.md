---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/boundary-lint': minor
'@substrat-run/engine-workorder': patch
'@substrat-run/engine-invoicing': patch
'@substrat-run/engine-protocol': patch
'@substrat-run/engine-booking': patch
'@substrat-run/engine-absence': patch
'@substrat-run/engine-metering': patch
'@substrat-run/engine-invites': patch
---

Module code gets a clock, and loses the wall clock (#812).

`OperationContext` had no way to ask what time it was, so module code reached past the
kernel for one: 95 hand-rolled `new Date()` / `Date.now()` calls across `engines/*` and
`demos/*`, stamping rows the host could not see. Meanwhile `contracts/ids.ts` described
the `instant` brand as "stamped kernel-side, never caller-side" — true of events, false
of every domain row in the repo.

`ctx.now(): Instant` is that clock, and `boundary-lint` **R6** is what keeps it the only
one — the same class of ban as R2's `node:*`, and shipped in `@substrat-run/boundary-lint`
so it enforces on generated and third-party verticals too.

**It is stable for the whole invocation.** Every call within one operation returns the
same instant, so two rows written in one transaction cannot disagree about when they were
written, and an event carries the same instant as the row it describes. That is a promise
about the value, not an optimisation: it is what a frozen clock rests on. Both hosts stamp
it once when the context is built, and route `emit`'s `occurredAt` and `requestPlatform`'s
`requested_at` through the same value.

**The point is what becomes testable.** The host takes a `clock` (the same seam as
`fetch`), and `manualClock` / `frozenClock` ship from the kernel. `demos/shop` has the
worked example: its scenario suite already "covered" hold expiry by passing
`holdSeconds: 0`, which proves an already-expired hold is swept and nothing about expiry.
The new `test/hold-expiry.test.ts` holds a unit for its real fifteen minutes, asserts it is
still reserved at fourteen, and gone at sixteen — with no real time elapsed.

R6 has a reviewable `boundary-lint-allow R6` … `boundary-lint-end R6` block, because
unlike R5's one-time handoff there is a recurring legitimate case: a timestamp a *remote*
clock judges. The three uses in `apps/dashboard` are a GitHub App JWT's `iat`/`exp` and
two `capturedAt` provenance stamps in host-driving code that has no operation to borrow an
instant from.

Timestamps are pinned to ISO 8601 text. The issue expected drift to migrate here; on
inspection there was none in module code — every Substrat table already stores ISO text,
and the epoch integers are Better Auth's own schema in `demos/auth-server`, which is that
library's storage contract rather than ours. Recorded rather than migrated.
