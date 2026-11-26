---
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/router': patch
'@substrat-run/control-plane': patch
---

The routing read model (#3395, K-72 proposed). With a `ROUTES` KV namespace bound, the control plane's directory publishes every route and every vertical's serving policy to it, captured by triggers in the same transaction as each change, reconciled by the scheduled pass and re-published after a restore. `createReadModelRouteResolver` reads memory → KV → the directory, and the router's `ROUTE_READ_MODEL` (`off` by default, `compare`, `on`) decides whether it does. Residency-pinned routes are never published (K-36).
