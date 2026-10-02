---
'@substrat-run/control-plane-api': patch
---

`mapError`'s `CODE_PATTERNS` table loses three rows — `is owned by`, `is auto-admitted (private self-serve)` and `not admitted` — 19 rows to 16 (#113 phase 5). Both adapters now throw those registry refusals typed as `conflict`, so the code is read from the declaration one branch earlier and the rows had nothing left to match. The response is unchanged — same 409, same detail — and every other row is untouched. An untyped throw of the same sentences now falls through to the generic 500, which is the point, and a new case pins both halves.
