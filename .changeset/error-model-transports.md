---
'@substrat-run/contracts': minor
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'create-substrat': minor
'@substrat-run/demo-callout': patch
'@substrat-run/demo-todo': patch
'@substrat-run/demo-handlebar': patch
'@substrat-run/demo-manyfold': patch
'@substrat-run/demo-meridian': patch
'@substrat-run/demo-shop': patch
'@substrat-run/demo-rally': patch
---

Every surface answers problem+json — and the message-matching goes with it

`/openapi.json` has said `application/problem+json` on every error response since the error
model's first phase. Nothing served one. Seven verticals, the scaffold template and the
control plane each hand-rolled a handler that read a status out of an error's **prose** —
`/not found/` → 404, `/out of stock/` → 409, `/cannot edit|frozen|already/` → 409 — and
answered `{ error: "<message>" }`. This is phase 4 of #113: the transports read the code.

```http
409 Conflict
content-type: application/problem+json
```
```json
{ "type": "https://substrat.net/errors/conflict", "title": "Conflict", "status": 409,
  "detail": "out of stock: SKU-14 — 2 available, 5 requested", "code": "conflict",
  "reason": "out_of_stock", "instance": "/api/op/shop/add-to-cart",
  "error": "out of stock: SKU-14 — 2 available, 5 requested" }
```

**The patterns were not kept as a fallback; the throw sites were typed instead.** A regex
table living beside typed throws is a table nobody maintains. So 73 raw `new Error(...)`
across the six verticals became `substratError('conflict', …, { reason })` — the platform
owns the code, the vertical owns the reason — and the two platform refusals every vertical
had independently hand-matched (`unknown operation`, `operation not entitled`) are typed in
the adapters and the kernel where they are raised. Seven `onError` handlers are one line
each now. `problemResponse(c, err)` is exported from `@substrat-run/vertical-host` and is
what the scaffold template ships with.

**A body with no `code` is information.** Two failures reach a transport that the closed
taxonomy cannot name: a throw nobody typed (answered with the caller's 400, deliberately —
an unrecognised throw must not claim to be the platform's fault) and a status raised
somewhere else (a downstream vertical's refusal, a Durable Object fault's 502). Those get
RFC 9457's `about:blank` form — status, message, no code — because inventing one would put
our vocabulary on a failure we cannot describe, and a client switching on `code` would
match it. `problem.code` is optional in the schema for exactly that reason, and the absence
doubles as a visible to-do list: every one marks a throw site still untyped.

**Nothing breaks.** `error` still duplicates `detail` on every body, which is why roughly
thirty contract-suite assertions on message text, and every SPA in the repo, went green
untouched. It goes in phase 5, along with the last patterns; `detail` is what to read.

Three deliberate exclusions, stated rather than hidden:

* **`engine-booking`'s `SlotUnavailable`** publishes its own `code = 'SLOT_UNAVAILABLE'`,
  which both RallyPoint clients switch on. An engine surface evolves additively only, so
  retyping it is a dual-emit through a deprecation window — `demos/rally` answers it by
  hand and says so.
* **`demos/auth-server`** is an OIDC issuer whose OAuth endpoints owe RFC 6749 error
  bodies, where `error` is an OAuth code rather than a message. Merging the two
  vocabularies on one surface is the OAuth work's call, not a transport sweep's.
* **The control plane's 23 remaining patterns** cover untyped `HostAdmin` throws. The table
  names a **code** per row now instead of a status, so an entry says what the failure IS and
  the status follows from the catalog — the two can no longer disagree.

**Statuses moved, and that is the point.** A vertical's default for anything its pattern
list did not recognise was the caller's 400, so every domain refusal that did not happen to
say "not found" arrived as one: `cart is empty`, `discount code expired`, `the club is
closed on 2026-08-25`, `no employment terms set`, `only a submitted expense can be decided`.
Those are 409 now — the request was well-formed and the state refused it — and `no such
plan` / `no such credit pack` are 404, which their wording had hidden from the pattern that
would have caught them. No client in the repo branches on those statuses (the demo SPAs
read `{ error }`, and only Todo's reads a status at all, for 403), so this lands as a
correction rather than a break.

One outright fix falls out: Manyfold's public delivery read of an unpublished slug answered
409, because `not published` sat in an app-level pattern list that meant "conflict". It is a
404 — the entry does not exist yet.
