---
'@substrat-run/control-plane-api': patch
---

The bound-scope delete refusal reaches the caller. `deleteVertical` refuses
while any scope is still bound, naming the count and the way out ("still backs
N scope(s) — delete or rebind them first"), but `mapError` had no pattern for
the message, so the console showed the generic 500 "internal error" instead —
exactly the masking the route's own comment claimed could not happen. The
message now maps to a 409 like the registry's other state conflicts.
