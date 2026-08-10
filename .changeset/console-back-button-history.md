---
'@substrat-run/console': patch
---

fix(console): navigation pushes history entries so Back stays in the console

The console's URL router reflected every navigation with `replaceState` only, so
drilling into a scope (or any other detail, or switching views) never added a
history entry — Back left the site entirely. `writeNav` now pushes when the path
actually changes and keeps replace for the two same-path cases: the initial mount
(normalizing a legacy `?view=` link without adding an entry) and the reflect that
runs after a popstate, where pushing would re-stack the entry Back just popped.
Every navigation funnels through this one function, so sidebar switches, the
scope/tenant/vertical drill-ins, and the cross-view jumps all get correct
back/forward behavior at once.
