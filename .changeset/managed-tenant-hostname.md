---
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
---

A tenant created through `provision-tenant` gets the default hostname `<tenant-slug>-<vertical>.global.<base domain>`, with the scope id's last six characters appended when another app holds that name. The request's result records it as `hostname`.
