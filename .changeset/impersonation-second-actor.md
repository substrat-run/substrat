---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

Impersonation: acting as a principal with the real actor preserved

Supporting a customer's live vertical meant asking them for screenshots. There was no
supported way to see what a named principal sees, and the obvious way to add one — swap
the staff session for the customer's — is the version that fails an audit: the real actor
is gone, and the trail says a customer approved an invoice a support engineer approved.

`ScopeHost.getImpersonatedScope(request, tenantId, scopeId)` is a fourth scope door beside
`getScope`, `getConnectorScope` and `getSystemScope`. Every gate `getScope` applies applies
here first; what it adds is a **second actor**. Permissions resolve as the impersonated
principal — a handler needs no change to be impersonatable — and every record keeps both:
the event's `actor` stays the principal it acted AS, and a new kernel-stamped
`impersonation` column beside K-34's `authorization` names the staff actor who was really
at the keyboard, the reason they gave, and the window it was valid in. Module code can
read it (`ctx.impersonation`, `null` in the ordinary case) and can neither set nor suppress
it — the K-34 argument, applied to a second fact.

Four bounds, each answering one of the questions [#868](https://github.com/substrat-run/substrat/issues/868) left open:

- **Read-only by default.** `writes: true` is an explicit opt-in. A read-only session
  refuses `ctx.emit`, `ctx.requestPlatform`, `ctx.grant`, `ctx.revoke` and `ctx.link`
  loudly — telling a support engineer their fix landed when it was discarded is worse
  than refusing — and never commits at all, which is the backstop for a handler that
  writes through `ctx.sql` and emits nothing. The issue proposed intersecting the two
  actors' permissions instead; that intersection is empty by construction, since K-20
  branded a `PlatformActorId` apart from a `PrincipalId` precisely so a staff actor holds
  no tuples in a tenant's scope.
- **Time-boxed**, checked on every invoke rather than once at the door — a stub is an
  object a caller can hold, so a mint-time check bounds nothing. `ttlSeconds` defaults to
  30 minutes and is capped at four hours.
- **Reason-carrying and required**, riding into the admin log and onto every event.
- **Announced before it exists.** The new `impersonate` admin action is recorded before
  the stub is returned, so a session that dies mid-way still left the record that it began.

Both adapters implement it, and the shared contract suite runs in-process and in workerd —
including the read-only rollback, which the two reach by different mechanisms (`ROLLBACK`
on the pure adapter; a failed `ctx.storage.transaction` in the DO, which has no such verb).

Additive throughout: `impersonation` is optional on the envelope, nullable in the DDL, and
absent on every historical event — where its absence is a fact, not a gap.
