---
'@substrat-run/dashboard': minor
---

The Verticals page can remove a pushed vertical, and each card collapses to its
newest 3 versions. Remove renders only while the vertical is PRIVATE (retiring a
published one stays a staff decision, mirroring the prod-promotion split) and is
owned-slug-checked like promote; below the seam the registry refuses while any
scope still runs the vertical, so a removal can never strand an install —
deployed dispatch scripts become orphans for cleanup (#248). "All N versions"
expands the version list in place.
