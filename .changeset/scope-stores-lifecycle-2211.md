---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
---

A scope dump carries its scope stores. `stores` lists each binding with its kind and opaque tables, and defaults to an empty list, so a dump from before stores still loads. On a host that runs its stores itself (the pure adapter, in dev and in tests), export, import, restore and snapshot carry them, and reap and fork delete wipe them before the scope's own storage goes. A restore refuses, before anything is written, a binding that is not bound, a store of another kind, and stores for a scope with no vertical. The scope's tables load before its stores. A backup copies the stores unsealed, and a masked export omits them.

Hosted, the control plane reaches the stores through its own path to the store script (#2254), never through the vertical. With no store kind registered it reaches none, and every copy runs as before.
