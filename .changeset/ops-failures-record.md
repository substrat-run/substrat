---
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/contract-tests": minor
"@substrat-run/control-plane-api": minor
---

feat(platform): operational failures get a durable, queryable record (#559 step 3)

A failed deploy, install, or preview restore left no durable trace — the admin log
audits successful mutations only (by design: it answers "who changed what", and a
failure changed nothing), so the 2026-08-08 preview-restore incident was diagnosable
solely from a vertical script's short-retention observability logs.

`HostAdmin` gains `recordOpsFailure` / `listOpsFailures` over a new
`_substrat_ops_failures` directory table (both adapters, contract-tested): actor,
operation, stage, tenant/scope/vertical, answered status, bounded message, and the
upstream provider's trace reference (Cloudflare's `internal error; reference = <id>`)
extracted into its own searchable column. Retention-bounded telemetry, not evidence:
rows self-prune on write after `OPS_FAILURE_RETENTION_DAYS` (90), so the table needs
no cron and can never grow without bound.

The control-plane transport records from three places — the error boundary (any
answered 5xx except 501, including a downstream vertical's 502 passthrough), the
deploy-upload catch (both the 502 platform-failure and the 422 bad-bundle, for the
coming builder-facing view), and the install-provision catch after its retry is
exhausted — and serves `GET /ops-failures` (staff-only, paged, filterable by
vertical/tenant/operation/reference, newest first).
