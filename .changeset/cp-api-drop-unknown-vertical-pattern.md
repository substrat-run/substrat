---
'@substrat-run/control-plane-api': patch
---

`mapError`'s `CODE_PATTERNS` table loses its `unknown vertical` row (#113 phase 5). Both adapters now throw that refusal typed, so the code is read from the declaration one branch earlier and the row had nothing left to match. The response is unchanged — same 404, same detail — and every other row in the table is untouched. The row could only go after the throws were typed: an untyped `unknown vertical` now falls through to the generic 500, which is the point, and a new case pins both halves.
