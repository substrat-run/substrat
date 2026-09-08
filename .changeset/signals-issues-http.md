---
'@substrat-run/control-plane-api': minor
---

The issues store gets its HTTP surface (#1233). `GET /issues` lists the
fingerprint-grouped failure classes — status/operation/code filters, no cursor
by design (grouping IS the compression; `limit` bounds the read). `PUT
/issues/status` records the staff verdict: resolve, ignore, or reopen — the
fingerprint rides in the body because it embeds U+001F by construction, and
`regressed` is refused at the schema (it is ingest's word only). Both routes
are staff-only: an issue is a fleet-scoped aggregate with no tenant column, so
the forced-filter posture cannot narrow it — a builder's per-app view derives
from their tenant-forced `/ops-failures` instead.
