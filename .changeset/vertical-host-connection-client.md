---
'@substrat-run/vertical-host': minor
---

Add `upsertConnection`, `bindConnection` and `unbindConnection`: a vertical's worker stores a connection, and binds or unbinds a scope's own connection to that scope with its own options, without hand-writing the relay calls.
