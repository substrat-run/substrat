---
'@substrat-run/kernel': patch
---

`readLifecycleFlow` now counts a declared self-transition, an edge from a state back to the same state. The move is counted on its edge once per call. It does not end the stay: the instance never left, so the move adds no entry and no time-in-state sample.
