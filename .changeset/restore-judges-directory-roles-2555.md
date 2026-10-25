---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

A staff restore or import on a host the control plane runs judges the tenant's roles against the dump before loading it (#2555).

- **`restoreScope` and `importScope` can now refuse.** The load brings the dump's scope-level seats under the tenant's roles as the directory stores them now, so the roles the dump seats or stores are judged first, against the dump's own role rows and seats, by the rule a CP-less restore already uses. A dump holding a seat in a role the directory has since made `holder: 'system'` is refused unless the dump stores that role system-held itself. A dump with no role rows (a pure-SQLite scope file, or a Cloudflare scope that reads its roles over RPC) cannot say which definition its seats were made under, so such a seat is judged as a person's: on such a host, a scope holding a seat in a system-held role cannot be restored from its own export. No role is system-held on such a host today.
- **What the caller sees.** The verb throws `forbidden` with one of two fixed sentences naming the role key only; the second says the dump carries no definition of the role. The control plane's restore route answers it as any dump it cannot load: 422, with the sentence in `detail`.
- **Nothing moves on a refusal.** A restore is refused before the orphan-sweep fence and the load; an import before its scope is created. The pure host judges again inside the load's transaction, and an import refused there takes the scope it created down again.
- **A preview's snapshot is not judged**: it copies a live scope of the same host at once. It still runs the store check.
- **kernel:** `dumpRoleRefusal(roles, reservations, dump, now)` is the one helper both adapters call, built on `reservedRoleSetRefusal`'s own walk.
- **contract-tests:** `restoreRoleContractSuite`, run on both adapters (on Cloudflare with and without scope-local permissions).
