---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
---

`getScopeStore` is a door of its own. It checks the tenant and the scope, builds the object name itself, and returns a stub whose `invoke` takes an operation and an input. A `substrat.*` operation is refused before the store is called. A store that answers `{ error }` becomes a `StoreError`, whose taxonomy code comes from the status and whose own code and body ride along. The Cloudflare host reads `SUBSTRAT_STORE_<BINDING>` from the worker env, a direct binding for local development and tests; a hosted upload carries no store binding. The pure adapter checks the directory and then refuses, because it has no runner yet.
