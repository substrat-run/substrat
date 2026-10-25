---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contracts': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
---

Wire signing: the nonce store for signed calls pinned to a scope (RFC wire-signing §4, follow-on 5). A signed call that changes state and names its tenant and scope is accepted once; the same envelope sent again is refused as `replay`.

- **kernel.** `WIRE_NONCE_DDL`: two spine tables in every scope's own storage, `_substrat_wire_nonces` (`nonce` primary key, `until_s` integer Unix seconds, indexed) and `_substrat_wire_nonce_count` (one row). `claimWireNonceIn` is the one claim both adapters make: in one transaction it purges up to `WIRE_NONCE_PURGE_BATCH` (64) rows whose window has passed, answers `false` for a claim after `until` or a nonce already held, `'full'` at `WIRE_NONCE_CAP` (180 000 live nonces), and `true` once it has recorded the nonce. `isWireNonceTable` and `isWireNonceWrite` mark the store as store-local. `WIRE_NONCE_FULL` is the cap's sentence.
- **adapter-sqlite and adapter-cloudflare.** Both build the tables in `KERNEL_DDL` and expose `claimWireNonceLocal(tenantId, scopeId, nonce, until)`. The answer is `true` or `false`, and the store at its cap throws. On the hosted adapter the claim is a new ScopeDO method, `claimWireNonce`. It runs on the bookkeeping path, so it advances no write revision a carry fences on. On both adapters no dump carries the tables and no load takes them from one, so a load, restore, wipe or delete leaves the store empty, and a rewind leaves it as it was at the bookmark. There is no provisioned check: the call that provisions a scope spends its nonce there too.
- **control-plane-api.** The platform's entry fills the verifier's nonce seam through the scope host the vertical registered with `mountPlatformSurface` (`platform-entry/nonce-store.ts`, `nonceStoreOf`). The seam now takes the tenant beside the scope. A bundle that registers no host, or a host from before the store, stays the `no-nonce-store` fault. A store that throws or is at its cap is the `nonce-store` fault, a 503 in every state. The readiness report adds a standing blocker on `signed-only` for the nonce store, which no record can show yet. The entry is re-emitted.
- **contracts.** `WIRE_FAULTS` gains `unscoped`: a call that keeps nonces and names no scope, which no version's store can hold, is counted apart from a version with no store. The list only grows.
- **contract-tests.** `wireNonceContractSuite`, run on both adapters.
- **Version skew.** A version built before the store answers as it did: the `no-nonce-store` fault, handed on in `dual`. A call with no envelope never reaches the store. Under `signed-only`, a version without the store answers every scoped call that changes state with the fault, which is why the readiness report blocks on it.
