---
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
'@substrat-run/vertical-host': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/control-plane': patch
'@substrat-run/docs': patch
---

The orphan-attachment sweep's dry-run-first rule is now held by the scope's own storage, so it holds whoever asks for a pass.

**What is recorded.** A dry run records the ids it listed (at most 1,000, `ORPHAN_SWEEP_LICENCE_CAP`) in a new spine table, `_substrat_attachment_sweep_licence`, stamped with the host's clock. It writes only when that set differs from the one held, or the one held is older than half the window, so a scope whose orphans stay the same moves no write revision on every pass. A dry run that lists nothing clears the record. A dry run the restore fence holds lists nothing and leaves the record as it was. A destructive pass also takes every licensed id its listing no longer holds out of the record, so a record with nothing left to delete sends the scope back to a dry run instead of holding it until it expires. A destructive pass that cannot bring the record up to date afterwards still returns its report, marked `consumeFailed`; the phase counts it, and the deployment's log line names it.

**The rule.** A destructive pass is refused with `conflict`, reason `orphan_sweep_unlicensed` (`ORPHAN_SWEEP_UNLICENSED`), unless the scope holds such a record from the last seven days (`ORPHAN_SWEEP_DRY_RUN_WINDOW_MS`). The refusal comes before anything is listed. The pass deletes only ids the record lists, and each id it deletes leaves the record, so one dry run can license several passes that work through a backlog. Every other guard of the pass still applies to each listed id.

**Loads.** A dump never carries the record, and every restore, carry or fork drops it, so a loaded scope's next pass is a dry run.

**The control plane's phase.** It keeps its admin-log rule, which still guards deployments pushed before this change. When a scope refuses a destructive pass for want of its own record, the phase dry-runs it in the same visit and counts it in `awaitingDryRun`. `OrphanAttachmentOutcome` gains `{ unlicensed }` for that answer. `OrphanSweepScope` gains `license`, `licensed` and `consume`.
