---
'@substrat-run/builder': minor
'@substrat-run/builder-web': minor
'@substrat-run/control-plane': minor
---

feat(builder): team-scoped studio — slug URLs, team picker, per-team DOs

The hosted studio partitions by team (= tenant, dashboard-teams.md). The URL's
first segment is the team slug (`builder.substrat.net/<team-slug>`, the
dashboard's scheme verbatim); every API call names its team via
`x-substrat-tenant`; and each team gets its own BuilderAgent DO
(`idFromName(tenantId)`), so projects, history, and names partition by tenant.
Membership is resolved from the shared control plane's identity directory via a
new service-token-gated `POST /internal/builder/identity-tenants` over a
service binding. The staff roster remains as an AND-gate until the builder
entitlement flag exists on plans; the pre-teams shared `'studio'` instance is
deliberately abandoned, not migrated. Design record: builder-studio.md §14.
