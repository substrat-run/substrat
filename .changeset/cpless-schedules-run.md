---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

Declared schedules run on a CP-less host (#461). `provisionScopeLocal` now projects each registered module's `system:<moduleId>` schedule grants (#383) into the scope's tuples, in the same atomic projection unit as the owner grant — without them the grant-is-the-switch check reported `fired: 0` forever, indistinguishable from "nothing due". And `runDueSchedules` skips the control-plane liveness read on a CP-less host, which has no directory to ask and already trusts the router-asserted (tenant, scope). `scheduleMod` is now exported from contract-tests for adapter-level CP-less coverage.
