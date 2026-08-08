---
"@substrat-run/control-plane-api": minor
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/contract-tests": patch
---

feat(platform): the stored copies get a lifecycle, and only an operator can start the clock (#557)

The backup buckets kept every copy forever: `scopes/` reap copies (#493) and `access-log/`
NDJSON batches (#553) had no lifecycle rule — the one retention decision #36's closure left
unmade. (`directory/` copies were never the gap; their 30-copy window has lived in
`backupDirectoryIfDue` since #40.)

**`pruneScopeBackups` / `pruneAccessLogBatches`** (control-plane-api) enforce an age window
over their own prefix, in code rather than as an R2 bucket rule so the policy is visible in
the repo and portable to any store. Both are conservative by construction: an object that
cannot be dated is kept, and an access-log batch is dated by its **newest** row — never
dropped while it still holds in-window rows. The CP worker's sweep runs them behind two new
opt-in vars, `SCOPE_BACKUP_RETENTION_DAYS` and `ACCESS_LOG_RETENTION_DAYS`; unset — the
default — deletes nothing, the same posture as the reap windows: the platform never deletes
evidence on a schedule a human did not choose.

**The drive-by #553 flagged:** `pruneAccessLog`'s admin-log row carried its payload in
`before`, inverted from `adminLogEntry`'s contract (before = prior state, after = the
applied payload). Both adapters now record `after: { pruned }`, matching `drainAccessLog`,
and the contract suite pins the shape.
