---
'@substrat-run/contract-tests': minor
'@substrat-run/adapter-sqlite': minor
---

Scope stores on the pure adapter (#2213). `@substrat-run/contract-tests` adds `scopeStoreRunnerContractSuite`, which a scope-store kind runs against its own runner: one object per whole address, a restart that keeps them, the envelope, and the shapes of the five reserved operations. It also exports the trivial kind's runner as `counterScopeStoreRunner`. `@substrat-run/adapter-sqlite` adds `scopeStoreRunnersFor`, which builds a dev host's `scopeStores.runners` from the vertical's declared scope stores and one runner per kind.
