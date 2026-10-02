---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

Refused lifecycle moves can now be read back row by row. `HostAdmin.listRefusals` returns a scope's recorded refusals newest first: the record, the state it was in, the operation, where that operation leads when it is legal, who tried and what kind of actor they are, the problem code (`invalid_transition`), and the call it happened in. You can narrow it by record, actor, operation, call or time window, the same way you narrow the denial log, and each read leaves an access-log entry.
