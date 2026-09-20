---
'@substrat-run/control-plane-api': patch
---

Deleting a vertical that still backs an ARCHIVED scope answers **409 with the refusal that names the way out**, where it used to answer a generic 500 saying `internal error`.

`deleteVertical` refuses twice, and `mapError`'s `CODE_PATTERNS` row read `/still backs \d+ scope\(s\)/` — which the archived sentence ("still backs 1 archived scope(s) — reap or restore them first") never matched, because the word `archived` sits between the digits and `scope(s)`. No other row caught it, so an operator who archived an app and then deleted its vertical was told nothing at all. Both adapters now throw that refusal typed, the 409 is read from the declaration one branch earlier, and the row is deleted — 20 rows to 19 (#113 phase 5). The LIVE variant's response is unchanged, and every other row in the table is untouched.
