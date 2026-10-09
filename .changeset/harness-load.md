---
'@substrat-run/contract-tests': patch
'@substrat-run/adapter-cloudflare': patch
---

The contract suites now accept vitest 4 and 5 as well as 3, and `defineScopeDO`'s return type now carries its env (`DurableObject<ScopeDoEnv>`).
