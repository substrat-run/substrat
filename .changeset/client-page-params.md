---
'@substrat-run/model-emit': minor
---

A generated client's paged reads now take the platform's `limit`, `order` and `sort` parameters, with `sort` typed as the read's declared sortable columns.
