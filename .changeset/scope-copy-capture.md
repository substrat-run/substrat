---
'@substrat-run/contracts': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
---

A paged scope copy can now catch up on the writes its source takes while it is read, so a later release can copy a busy scope without needing a quiet moment. A dump page read with `capture` opens a capture on the source and names each row by its source rowid (`rowids`). `exportDumpChanges` (`/internal/export-changes`, `exportScopeChanges`) hands over what was written since, in batches, and the final batch ends the capture at the write revision the copy is true at. `stageDumpChanges` (`/internal/stage-changes`, `stageScopeChanges`) applies a batch to the destination's stage, and `endDumpCapture` (`/internal/capture/end`, `endScopeCapture`) ends a capture whose copy stopped. A capture nobody asks for within one copy lease ends before the next write. Nothing calls these yet, and copies behave as before.
