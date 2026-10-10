---
"@substrat-run/contracts": patch
"@substrat-run/kernel": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/contract-tests": patch
"@substrat-run/control-plane-api": patch
---

Backfill the copy ledger with the per-script scope copies made before it existed. A staff route (`POST /scope-copies/backfill`) walks the admin log page by page, a dry run unless told otherwise. It derives where each scope's data lived from that scope's own rows: the serving scripts it was pinned to, the versions it was bound to while unpinned, the `prod` version its slug was born into, and, for a fork, its source's route at that moment. Each such script the ledger does not yet name is recorded as `retained` and audited as `backfillScopeCopy`, so reap and erasure reach it. A dry run reads no store; a real run reads only a derived home's metadata, and nothing wipes or deletes. What cannot be derived (including a birth whose slug changed in the 15 minutes before its directory row was written), or a script no deployment answers for, is reported as a failure and recorded in the ops log, and is never marked clean. Subjects erased in a scope before its copies were recorded are reported on every run. Once a move's own ledger entry for the same script settles, the backfilled entry settles with it.
