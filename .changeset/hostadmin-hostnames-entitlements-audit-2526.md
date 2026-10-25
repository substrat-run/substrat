---
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

HostAdmin's hostname and entitlement writes now commit with their audit row, on both adapters: `bindHostname`, `setHostnameStatus`, `setHostnameIssuance`, `unbindHostname`, `grantEntitlement` and `revokeEntitlement`. A refused audit insert leaves the state as it was, and a refused state write leaves no row. Each write reads its row, its guard and its row's `before` in the same transaction. `bindHostname`'s scope check, its check of the name's current holder, the demotion of the surface's old canonical and the bind are one unit, so a refused bind leaves the old canonical in place, and a name another live scope bound meanwhile is refused `conflict`. An audit row's fields are unchanged.

A write that changes nothing still records nothing, judged in the same transaction: a status the name already holds, an issuance poll that finds nothing new, an unchanged entitlement grant, a revoke of an entitlement not held, an unbind of a name not bound. On adapter-cloudflare a changed entitlement still fans out to the tenant's scopes after the commit; a refused projection rejects the call with `conflict` while the change and its row stand.

On adapter-cloudflare these writes now go through the ControlPlaneDO's `reply`: a new DO method `bindHostnameInDirectory`, and an optional trailing audit entry on `setHostnameStatus`, `setHostnameIssuance`, `deleteHostname`, `grantEntitlement` and `revokeEntitlement` (the first two now answer whether they wrote). A coordinator from before this change keeps working against the new ControlPlaneDO. A coordinator from after it, paired with an older ControlPlaneDO, refuses these writes with `not a replied directory method: <name>` and writes nothing. The workers that make these writes export the ControlPlaneDO class their own host calls, so the two ship together.
