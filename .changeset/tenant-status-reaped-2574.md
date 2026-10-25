---
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

`setTenantStatus` refuses a tenant that is already `reaped` (#2574). A reap keeps a tombstone row, and a status change could set it back to `active` or `suspended`; the call now answers `conflict` (`tenant <id> is reaped and cannot change status`) and writes nothing, judged on the status the write's own unit reads.
