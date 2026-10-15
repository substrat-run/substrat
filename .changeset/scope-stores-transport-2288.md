---
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/docs': patch
---

A Cloudflare host with no runner and no chosen transport calls a scope store through the platform hop (#2288), whether or not it has a control plane. An ambient `SUBSTRAT_STORE_*` namespace is used only when the host is given `transport: 'binding'` or a runner, and `transport: 'platform'` beside runners is refused. On the platform hop the host's local store size, export and erase refuse with `unavailable` instead of answering that there are no stores.
