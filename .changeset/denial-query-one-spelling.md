---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': patch
---

The denial-log filter has one encoder. `denialQuery(filter)` now ships from
`@substrat-run/contracts`, beside the `denialFilter` schema it serializes, and the
control-plane client uses it instead of its own copy — so a field added to the filter
reaches every caller instead of only the ones that remembered to copy the line. It
returns a `?`-prefixed suffix (or `''`), which also drops the dangling `?` the client
appended to an unnarrowed denial read.
