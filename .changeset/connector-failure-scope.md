---
'@substrat-run/kernel': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/control-plane': patch
---

A connector binding that fails a sweep, or a requested sync, is now filed as a pair under the pass's reference: a row for the connection's tenant carrying the app's scope, in the platform's words (with the connector's `said` when it gave one), and staff's row with the failure's own text (#3235). An app's Failures view and fleet health now include its own connector failures. A failure that names no scope stays staff's alone. kernel: `withheldOpsFailure` takes an optional `opening` for staff's row. control-plane: the failure digest pairs rows by scope too, so two bindings filed in the same instant stay apart.
