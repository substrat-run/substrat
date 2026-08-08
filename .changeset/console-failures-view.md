---
"@substrat-run/console": minor
---

feat(console): Operations → Failures — the ops-failure record gets its surface (#559)

A new Operations section in the sidebar lists the durable ops-failure rows
(#562's `GET /ops-failures`): time, operation · stage, vertical, tenant, status,
and the upstream `reference = <id>` as a copy-for-CF-support affordance — the
handle a CI log prints finally resolves to something on our side. Server-side
narrowing by tenant, vertical, and exact reference; row click shows the full
message.

The vertical detail joins in: a recent-failures strip (count · latest · jump to
the narrowed Failures view) that would have shown crm-eff's five failed restores
at a glance, and stuck-`provisioning` bound scopes now say *why* — "restore
failed (CF reference …)" — by joining the failure record on scopeId, instead of
sitting inert until the GC sweep reaps them.
