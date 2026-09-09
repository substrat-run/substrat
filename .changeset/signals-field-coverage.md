---
'@substrat-run/dashboard': minor
---

Field coverage lands on the app's Model tab (#1321, completing the static
half): which of the running version's declared fields is any operation even
capable of returning, and which of those are erasable — personal data the app
stores and never hands back, which is a retention argument rather than mere
cleanup.

Both halves come from artifacts the push already carries — `model` names every
declared field, `outputSurface` (#1349) names every field an operation declares
it returns — so this needs no telemetry, no sampling, and none of #114.

Two rules the view is careful about. It claims **"no operation declares this
field in its output"**, a fact about declarations that is exactly true, never
"nobody reads this", which would need traffic nobody counts yet. And matching
is by field name across the whole surface, so the never-returned list is
CONSERVATIVE: a field on it is named nowhere, while one absent from it may
still be unreachable — under-reporting being the safe direction for a list
whose purpose is to justify deleting something.

A version pushed before the output surface existed reads `available: false` and
says so. Rendering the join anyway would have reported every such app's entire
schema as dead.
