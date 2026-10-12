---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
---

The storage gauge samples scope stores. Each binding's size is kept beside the scope database, one row per day, and `/meters` adds it up when a sample exists. The sweep reads them on the same pass as the database, at most once a day, and retention drops them on the same horizon.
