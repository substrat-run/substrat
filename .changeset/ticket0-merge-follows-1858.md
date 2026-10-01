---
'@substrat-run/boundary-lint': patch
---

Merging ticket0 conversations now drops follows on the losing conversation and moves child permission edges to the survivor. Migration 0020 revokes historical losing follows and stale edges left by earlier merges.

Boundary lint now permits an explicitly marked permission-tuple tombstone in a generated SQL migration, while keeping other spine writes and operation code blocked.
