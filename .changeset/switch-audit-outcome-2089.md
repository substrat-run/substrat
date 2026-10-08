---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': minor
---

The schedule and peer kill switches (`revokeFromSystem`, `restoreToSystem`, `revokeFromPeer`, `restoreToPeer`) no longer drop a refused or failed outcome row without a trace (#2089). Both adapters used to write that row best-effort and discard the error. The audit now works the way #2064 made the owner hand-over and member changes work:

- **A refused or failed switch whose outcome row cannot be written** still answers with its own error (`not_found`, `conflict` and so on). The missing row is logged as `audit-outcome-unrecorded`, with the flow (`system-switch` or `peer-switch`) and the operation id.
- **A switch that moved but whose `applied` row cannot be written** answers success with `auditWarning`, beside the position it moved to. Before, it threw the log's error even though the switch had moved. `systemSwitchResult` and `peerSwitchResult` carry the optional `auditWarning`.
- **The scheduled settle closes these intents too.** The four switch actions are in `AUDITED_CHANGE_ACTIONS`, so `settleUnrecordedOutcomes` writes an `unknown` row (the intent's own fields, plus why) and an ops-failure row for each one left without an outcome. `GET /admin-log` gives their rows the `audited` field. The switch history counts only `applied` rows, so an `unknown` row moves no recorded position.
- **A delegated switch call is bounded.** `VerticalClient.systemSwitch`, `peerSwitch` and `switchFence` run under `AUDITED_CALL_DEADLINE_MS` (60 s), the deadline the settle's one-hour grace is built to outlast. Past it the call is aborted and answered `504`, and the switch is audited `failed`. A `504` does not prove the switch stayed still, so its position should be read before retrying.
- **The console's Schedules card and the dashboard's Peers panel show the warning.** A switch that moved but went unrecorded shows that it was made, that it could not be recorded, and that there is nothing to redo.

The outcome write is one kernel helper, `recordAuditOutcome`, used by the control plane's `auditedChange` and by both adapters' switch paths. The kernel also exports `UNRECORDED_OUTCOME_LOG`, `auditWarningOf` and `SWITCH_ACTIONS`. `auditOperationId` and `isWellFormedText` moved to the contracts' id module and are still exported from the package root. The `operationId` of `systemSwitchResult`, `peerSwitchResult` and `systemSwitchRecord` is now an `auditOperationId`: a well-formed string. `peerContractSuite` and `systemSwitchContractSuite` take a fixture with `refuseAdminRows`, built from the exported `adminRowFaultSql`.
