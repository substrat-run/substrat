---
'@substrat-run/control-plane-api': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
---

Deploy injects the version identity, and the outbox gains the signals `version`
dimension (#1242, the deferred half of #1231's outbox stamp). Every upload —
fresh archive script and in-place serve alike — now carries a
`SUBSTRAT_VERSION_ID` plain-text binding naming the version REGISTRY id it
deploys; `plain_text` is not in `keep_bindings`, so an in-place serve refreshes
it to the version actually being served. Both adapters stamp that id into a new
nullable `_substrat_outbox.version` column at emit, beside `operation` —
ALTERed into existing scopes, and re-applied after a legacy dump replay like
every other additive spine column.

The id is configuration handed in at the seam (the binding on Cloudflare, a
`versionId` host option on pure SQLite) — never read from the co-located
directory, so dev/CI/self-host and production stamp from the same kind of
source. Unconfigured, rows read NULL: unstamped, not a guessed value. The
version stays out of the `DomainEvent` envelope — it is a fact about the
process, not event data for module code to branch on.
