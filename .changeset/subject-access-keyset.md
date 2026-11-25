---
"@substrat-run/contracts": patch
"@substrat-run/kernel": patch
"@substrat-run/contract-tests": patch
"@substrat-run/control-plane-api": patch
---

Subject access now pages a declared entity's rows by primary key instead of by offset, so a row written or deleted while a package is being read no longer repeats or skips another of the person's rows. An entity's erasure declaration carries its primary key, derived from the model. A manifest derived before that still parses, and its rows are paged by offset as before. Each page's records and each package's records now say how they were paged (`paging: 'key' | 'offset'`), so a package can state when its paging was not stable against writes.
