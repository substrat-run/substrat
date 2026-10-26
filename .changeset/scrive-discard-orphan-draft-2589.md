---
'@substrat-run/connector-scrive': patch
---

A dispatch that fails after `createDocument` (a failed `setfile`, including a streamed integrity refusal, `update` or `start`) now trashes and deletes the draft it created, best-effort, instead of leaving it at Scrive for every retry to orphan (#2589). A failed cleanup never replaces the original error. Adds `ScriveApi.trash` and `ScriveApi.delete`.
