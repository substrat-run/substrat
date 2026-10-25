---
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
---

The table page and the SQL console refuse a scope the deployment does not hold (#2563), as the other introspection reads do (#2544): `conflict` with the shared sentence, not an empty answer, and on Cloudflare no stub call to a scope that is gone.

- adapter-cloudflare, adapter-sqlite: `introspectScopeTable` and `introspectScopeQuery` are guarded (Cloudflare: the single-call `introspectTableIfHeld` / `introspectQueryIfHeld`; SQLite gains both, refused from the directory). The carry's read of a wiped copy's tombstone is `readTombstoneTable`, which is not guarded.
- vertical-host: `GET /internal/tables/:table` guards when `held=1` (strictly that value) and reads as before without it; `POST /internal/query` is guarded. A control plane that predates the flag keeps working against this vertical.
- control-plane-api: `VerticalClient.readScopeTable` sends `held=1`; the new `readTombstoneTable` sends nothing and is what the carry and the copy cleanup call. A vertical that predates the flag ignores it.
- contract-tests: `introspectionReadsContractSuite` covers the table page and the console.
