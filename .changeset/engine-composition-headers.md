---
'@substrat-run/engine-workorder': patch
'@substrat-run/engine-booking': patch
'@substrat-run/engine-protocol': patch
'@substrat-run/engine-absence': patch
'@substrat-run/engine-invites': patch
'@substrat-run/engine-metering': patch
---

Each engine now states in its own header whether it is composed by call or by event, and
what follows from that — which functions a vertical imports, and why the registered
operations are the default bindings rather than a second way in. Only invoicing said so
before; the fact was scattered across `lifecycle.ts`, `operations.ts` and the docs, and two
engines said it nowhere. Comments only, no behaviour change.
