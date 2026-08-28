---
'@substrat-run/engine-absence': patch
---

engine-absence: the seam is parsed, not asserted (#771).

Every row this engine publishes now goes through the schema it publishes — a leave
type, a ledger entry, an absence request, and each `delta` the balance fold sums —
and no read is `SELECT *`: the column list is derived from the row schema, so a
column dropped upstream is a SQL error naming itself and a column added upstream is
never read. Behaviour-preserving for a caller against a matching version; a caller
running against a drifted table now gets an `internal` throw at the seam instead of
wrong data on a screen.
