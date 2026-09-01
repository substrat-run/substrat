---
'@substrat-run/kernel': minor
'@substrat-run/contract-tests': minor
---

A paged read can narrow on a SET of values, not only on one.

`ctx.page` filters composed `column = ?` and nothing else, so "every state but the
terminal one" — the shape every inbox wants for its default view — could not be asked
for at all. The alternatives were one request per state, whose pages cannot be merged
into a single walk, or a `!=`, which would make `filterable` mean something wider than
the indexed equality it provisions for.

A filter value that is an array now composes `IN (…)`. It is still equality, so it still
uses the index `filterable` provisions, and the count runs over the same `WHERE` as the
page. An EMPTY array matches no rows rather than being dropped: a caller that narrowed to
nothing asked for nothing, and handing back the whole table instead is a permission-shaped
bug wherever the set is computed from what the reader may see. Both adapters are held to
this by the `ctx.page` contract suite.
