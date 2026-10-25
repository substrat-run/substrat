---
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

HostAdmin's hostname and entitlement writes now commit with their audit row, on both adapters: `bindHostname`, `setHostnameStatus`, `setHostnameIssuance`, `unbindHostname`, `grantEntitlement` and `revokeEntitlement`. A refused audit insert leaves the state as it was, and a refused state write leaves no row. Each write reads its guard, its no-op judgement and its row's `before` in the same transaction; `bindHostname`'s demotion of the old canonical is in it too, so a refused bind leaves the old canonical in place. Audit row fields are unchanged, and a write that changes nothing still records nothing.

On adapter-cloudflare these writes go through the ControlPlaneDO's `reply`: a new DO method `bindHostnameInDirectory`, and an optional trailing audit entry on `setHostnameStatus`, `setHostnameIssuance`, `deleteHostname`, `grantEntitlement` and `revokeEntitlement`. A coordinator from before this change keeps working against the new ControlPlaneDO; a coordinator from after it, paired with an older ControlPlaneDO, refuses these writes with `not a replied directory method: <name>` and writes nothing.
