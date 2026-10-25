---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

A staff restore or import on a host the control plane runs judges the tenant's roles against the dump before loading it (#2555).

- **`restoreScope` and `importScope` can now refuse.** The load brings the dump's scope-level seats under the tenant's roles as the directory stores them now, so that role set is judged first, against the dump's own role rows and seats, by the rule a CP-less restore already uses. A dump holding a seat in a role the directory has since made `holder: 'system'` is refused (`forbidden`) unless the dump stores that role system-held itself. A dump with no role rows (a pure-SQLite scope file, or a Cloudflare scope that reads its roles over RPC) cannot say which definition its seats were made under, so such a seat is judged as a person's.
- **Nothing moves on a refusal.** A restore is refused before the orphan-sweep fence and the load; an import before its scope is created. The pure host judges again inside the load's transaction. The refusal is one fixed sentence naming the role key only.
- **A preview's snapshot is not judged**: it copies a live scope of the same host at once.
- **kernel:** `dumpRoleRefusal(roles, reservations, dump, now)` is the one helper both adapters call, built on `reservedRoleSetRefusal`'s own walk.
- **contract-tests:** `restoreRoleContractSuite`, run on both adapters (on Cloudflare with and without scope-local permissions).
