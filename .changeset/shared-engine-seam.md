---
'@substrat-run/contracts': minor
'@substrat-run/engine-workorder': patch
'@substrat-run/engine-booking': patch
'@substrat-run/engine-protocol': patch
'@substrat-run/engine-absence': patch
---

The engine seam helpers now have one home. `returns(schema, surface, value)` and
`columnsOf(schema)` — the pair that parses a value on its way out of an engine and
derives a SELECT list from the published schema — are exported from
`@substrat-run/contracts` as `engineSeam(name)`, and an engine binds them to its own
name in a line. Four engines carried byte-identical copies of the implementation,
differing only in the name each put into a seam failure. Behaviour is unchanged,
including the message a seam refusal carries.
