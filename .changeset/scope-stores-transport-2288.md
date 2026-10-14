---
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/docs': patch
---

A Cloudflare host with no control plane, no runner and no chosen transport calls a scope store through the platform hop (#2288). An ambient `SUBSTRAT_STORE_*` namespace is used only when the host is given `transport: 'binding'`, a runner, or a control plane.
