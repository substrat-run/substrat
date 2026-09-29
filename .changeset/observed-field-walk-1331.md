---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/vertical-host': minor
'@substrat-run/cli': patch
---

The vertical host can now record which of an operation's declared output fields each response actually carried, the observed half of field coverage. It is off by default and nothing turns it on yet, so a request costs and returns exactly what it did before. When the platform arms it, each mounted operation's response is checked against the field names its `output` declares: top-level fields only, the first entry of a list or paged read, at most 200 names. The result is written to the invocation record and its log line as `outputFields: { present, empty, absent }`. A field that comes back `null` counts as `empty` rather than as returned, so a column that is always null does not look used. Only declared field names are recorded. A value never is, and neither is a response key the declaration does not name.

Known gap: calls through the MCP endpoint are not walked yet, so a field that only an MCP client reads looks unread.

A declared environment variable can no longer use a name starting with `SUBSTRAT_`. That namespace is the platform's, and a key there could have switched on a platform setting from a vertical's own settings form. The deploy check already refused the prefix for bindings.
