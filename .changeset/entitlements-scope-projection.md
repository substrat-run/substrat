---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

A hosted vertical reads its entitlements at request time from a scope-local projection (#304),
settling kernel open-question 5 with the same answer as the routing cache.

Entitlements used to be a coordinator-only, trust-at-provision check: it gated *module loading*,
but a dispatched worker could not read `plan`/`quota`/`tier` at request time — the `CONTROL_PLANE`
binding is forbidden by the sandbox contract (#302) — and a CP-less scope short-circuited the gate
to `true`, enforcing nothing in-request, not even expiry.

Entitlements are now **projected into each scope** alongside roles and tenant tuples, extending the
scope-local-permissions machinery rather than duplicating it:

- **`OperationContext` gains `entitlement(key)` and `entitlements()`** — the sanctioned request-time
  read. Returns the live view (`key`, `plan`, `quota`, `expiresAt`) or `null`; expiry is applied at
  read, so a non-null result is always live. A hosted scope reads its local projection; a
  console-managed scope reads over the same RPC the permission checker uses. New `EntitlementView`
  contract type.
- **The per-operation gate fails closed against the projection** on the scope-local path — expiry
  and revocation now enforce at request time in a hosted vertical, not only at provision.
- **A grant/revoke fans out to invalidate** the projected scopes — the event-invalidation half of
  kernel open-question 5's answer (cached in scope DOs with event invalidation), deliberately the
  same project-on-write mechanism the routing/suspension cache defers to.

Two posture calls, per #33's grain:

- **Expose, don't enforce** `quota`/`plan`: the kernel gates presence + expiry; the vertical reads
  the number and enforces its own quota (no kernel usage-counting).
- **Fail-closed enforcement flips per scope** via an `entitlements_enforced` marker set the first
  time entitlements are projected — a scope provisioned before #304 keeps trusting upstream until a
  fan-out / reconcile / re-provision back-fills it, so the switch to strict enforcement strands no
  live scope.

`provisionScopeLocal` accepts an optional `entitlements` list (the platform passes the tenant's
grants at provision). Scoped out as a follow-up: the platform→dispatched-vertical provision path
(control-plane-api) does not yet *pass* entitlements into `provisionScopeLocal`, so re-projection to
a live dispatched worker rides re-provision/reconcile until that is wired; expiry still enforces
locally meanwhile, because the projected row carries it.
