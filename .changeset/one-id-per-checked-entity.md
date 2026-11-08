---
'@substrat-run/contracts': minor
---

**Breaking:** `defineOperations` refuses, at module load, an operation whose `permission` is `{ entity, idFrom }` and whose input takes a second field spelling the same id: a field equal to `idFrom`, or to `<entity>Id`, when case, `_` and `-` are ignored (`deal_id` beside `dealId`). The check reads `idFrom`, so a derived page filtering by the other field served any record the caller named. A vertical that declares such an input stops loading after upgrading; take the id once, in the field the path names. A bare `id` beside another `idFrom` is not refused.
