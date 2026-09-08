---
'@substrat-run/connector-planima': minor
'@substrat-run/kernel': patch
---

Add `@substrat-run/connector-planima` — the inbound half of Planima (Swedish planned
facility maintenance) integration.

Poll-only and read-only, in `connector-fortnox`'s shape: a connection is bound to a scope
with `bindPlanimaScope` (which refuses a binding whose grant is missing), and
`sweepPlanimaPlan` reads each bound scope's maintenance plan — facilities, buildings,
components, and the costed actions in a year window — hashes it, and lands it through the
consuming vertical's own operation as the connection itself. An unchanged plan lands
nothing.

The client throttles itself to Planima's 10-requests-per-10-seconds limit and obeys the
`Retry-After` a 429 carries. Prices arrive as JSON floats and cross the seam as exact
decimal money in a currency the binding declares, because Planima's API states none.

A plan that has become empty lands one explicit CLEAR page (`facility: null`,
`final: true`) rather than nothing, so a consumer that swaps on `final` cannot be left
holding the previous sync's rows for ever. A 200 whose body carries no `data` array is
refused as a response fault rather than read as an empty list. One rate-limit window is
shared across every binding in a sweep, because Planima meters per token rather than per
client.

`ConnectorResponse` gains an optional `headers` — some provider instructions (`Retry-After`
here) live only in a response header, and reading one had no sanctioned route through the
connector seam.
