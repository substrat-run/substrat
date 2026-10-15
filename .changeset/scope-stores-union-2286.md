---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
---

Export, wipe, erasure and the meter reach every scope-store binding any version of the vertical has declared (#2286), so an object under a binding a later version dropped is still reached, whatever moved the scope off the version that declared it. A restore still imports only what the destination's running version declares, and the router still admits only that version's bindings.

`@substrat-run/kernel` adds `HostAdmin.verticalScopeStores`: every binding any version of a vertical declared, with its kind, read by its keys from a directory record (`VERTICAL_SCOPE_STORES_DDL`), with no per-version work once the vertical is indexed. `publishVersion` keeps that record in the transaction that inserts the version, and refuses (`conflict`, 409 at the push) a version that declares an existing binding as another kind, judged against every older version, or one binding twice: a binding keeps its kind for the life of its vertical. A vertical whose versions were stored before the record is indexed by its first read or publish. `@substrat-run/adapter-sqlite` and `@substrat-run/adapter-cloudflare` keep the record, and `@substrat-run/contract-tests` holds both to it.

`@substrat-run/control-plane-api` adds `runningVersionStoresOf`, the running version's stores alone; `scopeStoresOf` is now the union. A backup, a full pull or a fork's export leaves out a binding only an earlier version declared when its export is empty, and refuses (409) one that still holds data, naming the binding: declare it again in a version the scope runs, or reap the scope without a backup.
