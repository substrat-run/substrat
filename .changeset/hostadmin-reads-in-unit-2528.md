---
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/kernel': patch
'@substrat-run/contract-tests': patch
---

HostAdmin's tenant and vertical directory writes now read their audit row's `before` and judge their guards in the same transaction that writes, on both adapters. That covers the listing, install-block, tenant-provisioner and email-sender flags, the publish request, delete (and its bound-scope refusal), admit and reject, the "prod is not auto-admitted" listing guard, whether a published version self-admits on a private vertical, and the serving state. The tenant status, name and reap writes on adapter-sqlite are covered as well (adapter-cloudflare already read them in the write's unit). An audit row's fields are unchanged.

One behaviour change: `setVerticalServing` is now a compare-and-set on the serving ref and version its gate judged. A serve that loses that race is refused with `precondition_failed` (kernel `servingRaceRefusal`) and writes nothing to the directory. Nothing retries it. The control-plane serve that calls it has already uploaded the serving script, and it passes the refusal up. Until a serve lands again, the script runs that serve's code while the directory names the other serve's; before this change the last writer won instead. The compare-and-set holds the host method's own read, not the serving state the caller read before its upload.

On adapter-cloudflare these writes now go through the ControlPlaneDO's `reply`, with new `admitVersion` and `rejectVersion` DO methods. A coordinator from before this change keeps working against the new ControlPlaneDO. A coordinator from after it, paired with an older ControlPlaneDO, refuses these writes with `not a replied directory method: <name>` and writes nothing. The workers that make these writes export the ControlPlaneDO class their own host calls, so the two ship together.
