---
'@substrat-run/contracts': patch
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/control-plane': patch
'@substrat-run/control-plane-client': patch
'@substrat-run/cli': patch
---

A scope-store kind's release is stored, canaried and rolled out by a person (#2300). `substrat store-kind upload` stores a kind's package under its sha256, before or after its pin lands; `rollout` canaries a pinned release on the platform's own object through every reserved operation, then moves every vertical that declared the kind, holding the kind against pushes while it does; `rollback` returns to the immediately previous good release. A failure returns the verticals already moved. Each pin now names the `schema` its release migrates to, and no move lowers it.
