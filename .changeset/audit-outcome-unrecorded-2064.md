---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': patch
---

An owner hand-over or a dashboard member change no longer loses its outcome row without a trace (#2064). Both routes now run through one helper, `auditedChange`, which writes the intent, calls the vertical, then writes the outcome. When the `refused` or `failed` row cannot be written, the caller still gets the vertical's own status, and the gap is logged as `audit-outcome-unrecorded` with the operation id. When the `applied` row cannot be written, a member change answers `500`, saying the change completed and only its row is missing, as the hand-over already did. A member change's refusal now carries its `operationId` too. `settleUnrecordedOutcomes`, run by the control plane's scheduled pass, closes any intent still without an outcome after an hour with an `unknown` row and an ops-failure row, so the staff digest reports it. `ownerTransferAudit` and `memberChangeAudit` accept the new `unknown` phase. `AUDIT_ERROR_MAX` replaces `OWNER_TRANSFER_AUDIT_ERROR_MAX`, which remains as a deprecated alias.
