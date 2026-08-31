---
'@substrat-run/cli': patch
---

The CLI reads the control plane's problem documents. A refused `push`, `promote`,
`versions` or `installs` now prints the RFC 9457 `detail`, the taxonomy `code` and — on a
validation failure — the fields that were refused, instead of a slice of the raw JSON
body. A control plane still answering with the legacy `{ error }` body, and a response
that is not JSON at all, read exactly as before.
