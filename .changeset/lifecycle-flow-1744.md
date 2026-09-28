---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': minor
---

A declared lifecycle can now be read back as what actually happened. `readLifecycleFlow` replays one entity type's events against its lifecycle declaration and answers the process map's numbers:
- how many times each edge was taken, and by what kind of actor; a declared edge nobody took is listed at 0, and a move the declaration does not have is kept apart;
- how many instances are in each state now;
- median and p90 time in state;
- the instances stuck longest;
- the funnel from the initial state.

It is exposed as the `lifecycleFlow` platform read, through the vertical's new `/internal/lifecycle-flow` route and the control plane's `lifecycle-flow` route, and logged like every other scope read. A state is taken from the event's payload when it carries the lifecycle field and holds no personal data, and inferred from the declared edge otherwise. The replay is bounded and says so when it stops early. A vertical serves the read once it is pushed on this release.
