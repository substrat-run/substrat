---
"@substrat-run/kernel": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/control-plane-api": patch
"@substrat-run/contract-tests": patch
---

Subject erasure now reaches the spine's free-text columns. A recorded idempotent response that names the subject becomes a redaction tombstone, and a retry under its key is refused rather than replayed or re-run. Ops-failure messages, issue exemplars and sweep records are rewritten to a redaction note when they quote an intent the erasure redacted or name the subject's id. Another tenant's rows are never touched. Issues now record whose failure their exemplar came from (`_substrat_issues.last_owner_kind` and `last_tenant_id`, additive directory columns, backfilled where the retained failure rows prove a single origin). A tenant's exemplar is rewritten only for that tenant, the platform's own on a direct match, and one of unknown origin is left alone. A queued `sweep-runs` intent gets the same note in the entry error that named the subject. Erasing through a coordinator now refuses a scope still running an older ScopeDO that cannot do this, before the subject key is destroyed. The scheduled platform pass now also prunes ops failures, issues and sweep runs past their retention (`HostAdmin.pruneTelemetry`), so those bounds hold on a directory that records nothing new.
