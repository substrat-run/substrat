---
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/kernel': patch
'@substrat-run/contract-tests': patch
---

HostAdmin's tenant and vertical directory writes now read their audit row's `before` and judge their guards in the same transaction that writes, on both adapters. That covers the listing, install-block, tenant-provisioner and email-sender flags, the publish request, delete (and its bound-scope refusal), admit and reject, the "prod is not auto-admitted" listing guard, whether a published version self-admits on a private vertical, and the serving state. The tenant status, name and reap writes on adapter-sqlite are covered as well (adapter-cloudflare already read them in the write's unit). An audit row's fields are unchanged.

One behaviour change: `setVerticalServing` is now a compare-and-set on the serving version its gate judged. A serve that loses that race is refused with `precondition_failed` (kernel `servingRaceRefusal`), writes nothing, and is retried after reading the serving state again.

On adapter-cloudflare these writes now go through the ControlPlaneDO's `reply`, with new `admitVersion` and `rejectVersion` DO methods. A coordinator from before this change keeps working against the new ControlPlaneDO. A coordinator from after it, paired with an older ControlPlaneDO, refuses these writes with `not a replied directory method: <name>` and writes nothing. The workers that make these writes export the ControlPlaneDO class their own host calls, so the two ship together.
