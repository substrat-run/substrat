---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
---

A running scope host now knows which version it is, and stamps it on every event
(#1242, closing #1231's version gap). The deploy injects the version-registry id
as a `SUBSTRAT_VERSION_ID` plain_text binding — through the one uploader closure
both the per-version and the serving upload share, so neither path can be
forgotten — and the ScopeDO reads it from env; the sqlite adapter takes the same
value as `SqliteScopeHostOptions.versionId` (unset in dev = NULL rows, the
honest reading). The outbox gains a nullable `version` column beside
`operation`, surfaced on `historyEntry`, and unlike `operation` it also stamps
consumer-emitted events: the version is a fact about the deployed code, not
about what triggered the emit.

The stamp cannot be forged: the sandbox contract now refuses any declared
binding in the `SUBSTRAT_` namespace by name, whatever type it claims — the
CONTROL_PLANE precedent, applied to the platform's injected names. Scripts
deployed before this release carry no binding and their rows read NULL until
the next promote.
