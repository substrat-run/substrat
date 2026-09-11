---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': patch
---

The denial-log filter has one encoder. `denialFilterParams(filter)` and its URL-suffix
form `denialQuery(filter)` now ship from `@substrat-run/contracts`, beside the
`denialFilter` schema they serialize, and every client uses them instead of its own copy
— the control-plane client, the platform's vertical client (the hosted branch of the same
two reads, which adds `scopeId`), and the admin console. A field added to the filter now
reaches every caller instead of only the ones that remembered to copy the line. The
control-plane client also drops the dangling `?` it appended to an unnarrowed denial read.
