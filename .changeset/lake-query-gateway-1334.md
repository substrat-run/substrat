---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
---

A query gateway for the Tier-2 lake (part of #1334). `GET /tenants/:tenantId/lake/events` reads one tenant's events from `kernel.events`, newest first, with filters for scope, event type, entity, actor, operation, version, impersonation and an `occurred_at` window, paged by event id. The tenant is the path segment and nothing else: `lakeEventsInput` has no tenant field and refuses unknown keys, the gateway builds every statement itself with `tenant_id = '<tenant>'` as its first condition and only values from a quote-free alphabet, and an answer holding any row of another tenant is refused whole. It returns the event envelope only: no payload, `subject_id`, authorization chain or impersonation record until erasure reaches the lake. Every read writes a K-24 access row (`lakeEvents`, a new arm of `delegatedReadRecord` whose scope may be null) before anything is returned, and a failed write fails the read. The route is staff only. It answers 501 unless the host passes a `lakeQuery` engine. `createR2SqlEngine` is the R2 SQL engine for that seam, and it has not yet been run against a real lake.
