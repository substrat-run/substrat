---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
---

A scope's copy-origin record now holds two separate facts. One is the copied-events mark: the newest event a load brought in from another scope, which that scope's queued work is held behind. The other is whether the scope is a copy, which a host with no control-plane directory reads to hold a copy's effects inert. A load into another scope id sets only the mark. The scope is classified a copy only when the platform's directory says it is not primary. That covers a preview, a fork and a snapshot, so one install's backup restored onto another install now runs its own effects, and the work it copied still never runs there. The new `_substrat_copy_origin.is_copy` column is added in place. A row written before it reads as a copy, as it always did. `clearCopyMarker` now clears the classification of any such row and keeps its events mark, so it no longer answers `carries-events`. Previews and snapshots are created with the directory's classification attached.
