---
'@substrat-run/dashboard': patch
---

Observability attributes traffic to the stable serving script, so the per-app
and team-wide traffic panels stop reading empty. Since #286 a vertical's real
traffic flows through one stable serving script (`<slug>`, addressed by
`scope.servingRef`) — not the per-version archive scripts (`<slug>-<ulid>`),
which only admit and probe a push. Cloudflare records invocations under the
serving name, but the builder owner-narrowing (`ownedServiceRefs`) only mapped
the archive refs, so `filter(r => owned.has(r.service))` dropped every
real-traffic row and the tab showed "No traffic recorded yet" even under live
load. The map now includes each scope's `servingRef`, stamped with the version
the scope is bound to (exact for the common single-scope app), and the panel
copy reads "serving version" rather than "deployed version" to match. Ownership
is unchanged: serving refs come from this tenant's own `listScopes`, and rows
outside the map are still filtered out.
