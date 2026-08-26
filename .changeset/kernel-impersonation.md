---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

Act as a principal with the real actor preserved (K-42)

Supporting a customer's live vertical meant asking them to screenshot things. The usual
fix is a session swap that LOSES the real actor, which is the version that fails an audit:
the trail says the customer did it and nothing anywhere says who actually did.

`host.getImpersonatedScope(session, principal, tenantId, scopeId)` mints an ordinary stub
with two differences.

**Permission evaluation is the impersonated principal's.** `ctx.check` answers exactly
what it would answer for them, so a support session reaches what the person being helped
reaches — including nothing. Intersecting with the staff actor's own permissions was
considered and cannot be built: a `PlatformActorId` is branded distinctly from a
`PrincipalId` (K-20) *because* a staff member is not a person in any tenant, so the
intersection is empty for every key. What gates who may impersonate is the mint, which is
a platform verb and is admin-logged as `impersonate` before the session exists.

**Every record keeps both.** `impersonation` — `{ by, reason, expiresAt }` — is stamped
kernel-side beside `actor` on the outbox, the denial log and the platform-intent journal,
and comes back through `readTimeline`/`readHistory`, so a history strip can say *Nadia,
acting as Anna* rather than *Anna*. It is absent from `DomainEventInput` exactly as K-34's
`authorization` is, so module code can neither claim a session nor drop the one it is in;
`ctx.impersonation` is readable so a handler can refuse an irreversible action under one.

Sessions are bounded (`expiresAt`, defaulted and capped at `IMPERSONATION_MAX_MINUTES`,
enforced per INVOKE rather than at the mint — a stub is held for as long as its holder
likes) and reason-carrying by schema — trimmed before the length is judged, so a reason
of `" "` is the empty one it is.

A staff mint the validation REFUSES is admin-logged too, as its own `impersonateRejected`
action. The check runs before the accepted entry can be written, so without it an expired
window or an empty reason would leave the log showing a clean history of exactly the
sessions that worked — and an attempt is the shape a probe has.

Both adapters implement it and a shared contract suite holds them to it. On the Cloudflare
adapter the ScopeDO acknowledges that it recorded the session and the coordinator refuses
the SUCCESS without that acknowledgement — the #129/#116 skew pattern, applied to the one
field whose loss would be invisible in the response.
