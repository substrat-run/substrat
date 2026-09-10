---
'@substrat-run/dashboard': minor
---

The dashboard can evaluate permissions from its scopes' own storage (#1343,
scope-local-permissions.md Phase 2), behind `SCOPE_LOCAL_PERMISSIONS` — enabled
on TEST, absent in production.

On, the host projects the tenant's roles, tenant-level tuples, entitlements and
identity links into its scopes on every tenant-level write, and those scopes
stop reading the shared control-plane Durable Object on every `ctx.check`. That
single global DO is on the permission hot path of every authenticated dashboard
request today, which is the design's own founding complaint about it.

A flag rather than a constant because flipping it changes how a live app answers
a permission check. Off is exactly today's behaviour. On is still incremental: a
scope keeps using the RPC path until a projection actually reaches it, and what
reaches it is a complete tenant snapshot, so no scope is ever flipped-but-empty.
New scopes project at provision; existing ones convert on their tenant's next
tenant-level write. Scopes that see neither stay on the RPC path indefinitely —
converting those wants a deliberate back-fill (`reconcileTenantProjection`),
which has no production trigger yet and is not part of this change.
