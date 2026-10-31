---
'@substrat-run/control-plane-api': minor
'@substrat-run/contracts': patch
'@substrat-run/adapter-cloudflare': patch
---

control-plane-api: a scope copy of a busy source catches up on the writes it took while it was read, instead of waiting for a quiet moment
contracts: a dump page says when it was read under the capture it was asked for (`captured`)
adapter-cloudflare: a dump page read under a capture says so
