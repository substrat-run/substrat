---
'@substrat-run/contract-tests': minor
---

`grantExpiryContractSuite` — a contract suite that grants a node-level and an entity-narrowed permission with an `expiresAt` an hour ahead, asserts both are live, moves a `ManualClock` past it and asserts both are refused (and that a later re-grant is live again on its own `expiresAt`). Its fixture returns `{ host, clock, cleanup }`, so only an adapter that can hand its host a clock mounts it; `adapter-sqlite` does. The Cloudflare adapter does not, because the Durable Object reads the wall clock and no option reaches it — the gap is written down in the package README rather than hidden behind a skip (#956).
