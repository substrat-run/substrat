---
'@substrat-run/builder-generator': minor
'@substrat-run/builder': minor
---

feat(builder): edit_file — strict search/replace edits instead of whole-file rewrites (#663 row 3)

The generator gains an `edit_file` tool (matching pipeline ported from aider,
Apache-2.0): exact match, uniform-indent-shift, and `...` elision — no fuzzy
apply; a miss returns a structured reflection (did-you-mean excerpt,
already-applied hint) the model corrects from. Offered format-per-model:
frontier providers get it, weak/local models keep whole-file writes by
declaration (`editToolFor` in model-pairs.ts). Cuts output tokens on the
common small-change-to-large-file case, which is billed at the strong-model
output rate.
