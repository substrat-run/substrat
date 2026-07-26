---
'@substrat-run/dashboard': patch
---

Create-app URL preview now shows the tenant-suffixed hostname. The page promised
`<app>.global.substrat.run` while provisioning actually binds
`<app>-<team>.global.substrat.run` (the tenant-suffix scheme in `bindDefaultHostname`).
The preview now mirrors the worker — same `slugify` on the current team's name,
falling back to the unsuffixed form for teamless sessions.
