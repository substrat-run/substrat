---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': minor
---

A reap keeps the storage days of the scope it reaps (#2515). The storage gauge used to delete a reaped scope's day rows at reap, so the month it was reaped in lost the bytes it held before the invoice for that month could be cut. Now the reap deletes only the scope's attempt row; its day rows stay, and the scope's tombstone row is what admits them. `listScopeStorage` history (anything but `latest`) reads the database days (the scope-store day rows are kept too, for a future store history read), the current gauge, the attempts and the meters still describe live storage only, and the existing thirteen-month retention ends them. A deleted fork and a reaped tenant still forget everything. kernel adds `retireScopeStorage` beside `forgetScopeStorage`. No table or column changes.
