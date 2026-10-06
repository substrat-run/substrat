---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': patch
---

An owner hand-over or a dashboard member change no longer loses its outcome row without a trace (#2064). Both routes now run through one helper, `auditedChange`, which writes the intent, calls the vertical, then writes the outcome.

- **A refusal or failure whose row cannot be written:** the caller still gets the vertical's own status, and the missing row is logged as `audit-outcome-unrecorded` with the operation id.
- **A change that went through but whose `applied` row cannot be written:** the answer is a success that carries `auditWarning`, with the result. An invite keeps its accept link. Before, the hand-over answered `500` and a member change threw. Every answer, refusals included, now carries `operationId`, the `AuditedAnswer` shape in contracts.
- **The vertical call** has a 60 s deadline (`AUDITED_CALL_DEADLINE_MS`). Past it the answer is `504`, audited `failed`.

`HostAdmin.settleUnrecordedOutcome` closes an intent left without an outcome. In one transaction, and only if no outcome exists by then, it writes an `unknown` row and an ops-failure row for the staff digest. The control plane's scheduled pass calls it through `settleUnrecordedOutcomes` for intents over an hour old. The pass refuses a grace window that does not exceed the call deadline. A real outcome recorded later supersedes `unknown`. `ownerTransferAudit` and `memberChangeAudit` accept the new `unknown` phase. `AUDIT_ERROR_MAX` replaces `OWNER_TRANSFER_AUDIT_ERROR_MAX`, which stays as a deprecated alias.
