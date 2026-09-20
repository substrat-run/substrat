---
'@substrat-run/control-plane-api': patch
---

`mapError`'s `CODE_PATTERNS` table loses its `was rejected — publish a new one` row — 19 rows to 18 (#113 phase 5). Both adapters now throw that refusal typed as `conflict`, so the code is read from the declaration one branch earlier and the row had nothing left to match. The response is unchanged — same 409, same detail — and every other row is untouched. An untyped throw of the same sentence now falls through to the generic 500, which is the point, and a new case pins both halves.
