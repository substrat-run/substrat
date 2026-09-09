---
'@substrat-run/dashboard-web': patch
'@substrat-run/dashboard': patch
---

The versions table on Verticals says when each version was pushed, and stops
crushing the version itself.

`Version` shared one narrow column with the schema-change badge and the push
origin — and the origin (`owner/repo@1a2b3c4`) is the longest thing in the row, so
a prerelease tag like `0.4.0-beta.7` had nowhere to go. Origin moved next to a new
`Pushed` column, where the two read as one fact: when the push landed and where it
came from. The column itself is relative ("3h ago", "yesterday", a date past a
week) with the exact instant on hover, matching how an app's own version list
already reads. `Promote` gave up the third of the table it was holding for one
small button.

A repo label also used to spill over the next column instead of clipping, because
a grid cell does not bound it on its own; it ellipsizes now, with the full repo,
ref and commit still in the tooltip and the commit link still clickable — which
fixes the same crowding on an app's Deployments tab.

The dev preview grew a prerelease carrying a schema change, since the widest case
a version cell has to survive was the one case the fixture never showed.
