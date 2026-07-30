---
'@substrat-run/dashboard-web': patch
---

Trim the Permissions tab honesty banner to one line.

The banner at the foot of an app's Permissions tab had grown to a four-sentence paragraph
crammed into a component built for single-line notes, so it wrapped awkwardly and repeated
things the surrounding UI already says (the "Entity grant shapes" card header already notes
grants are per-entity and minted at runtime; the update diff already links to the Deployments
tab). It now keeps just the two claims worth stating — this is the declared, read-only surface,
and role approval happens on the Deployments tab — matching the length of every other banner.
