---
'@substrat-run/kernel': patch
'@substrat-run/adapter-cloudflare': patch
---

Peer calls now find an app installed under a tenant-pinned name. A push pinned to a tenant registers the vertical as `<tenant>/<slug>`, while `substrat.calls` and `peers` name the bare `<slug>`, so the resolver reported the target as "not installed in this tenant" for an active, same-tenant install, and the app's peer door refused the caller as undeclared. The two spellings are now one vertical in the resolver, the target query, the caller check, explicit target bindings and the peer door; two matching installs still resolve as ambiguous until one is bound.
