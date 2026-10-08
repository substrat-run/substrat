---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

The replay lever (`HostAdmin.moveImportCursor`) no longer loses an outcome row without a trace (#2114). Its outcome rows now go through `recordAuditOutcome` in both adapters, as the kill switches' do.

- **A failed move whose `failed` row cannot be written:** the caller still gets the move's own error, and the missing row is logged as `audit-outcome-unrecorded` (flow `import-cursor`) with the replay id. Before, the write error was discarded silently.
- **An applied move whose `applied` row cannot be written:** the answer is the move, with a new optional `auditWarning` on `ImportCursorMoved`. Before, the call threw after the watermark had already moved.

The lever's admin-log rows now carry `operationId` (the same value as `replayId`), and `moveImportCursor` joins `AUDITED_CHANGE_ACTIONS`, so the scheduled settle closes an intent left without an outcome as `unknown`, with an ops-failure row for the staff digest. A lever row written before this release has no `operationId` and is passed over, as any such row is.
