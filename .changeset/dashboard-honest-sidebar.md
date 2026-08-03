---
'@substrat-run/dashboard': patch
---

Drop the hardcoded sidebar counts (Apps 4 / Domains 3 / Team 4) — design leftovers
that were never wired to data. With keyset pagination the loaded page length isn't a
true total either, so the honest sidebar shows no counts at all.
