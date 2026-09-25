---
"@substrat-run/dashboard-web": minor
---

An app's Deployments tab now opens with a release comparison: the version the app runs beside the one it could move to, with permission and schema changes tagged added, changed or removed, and the Update button in the same card. A Releases list shows when each version was pushed and when it went live as two separate columns, names who moved prod, counts the installs on each version, and says so when a go-live was rolled back. Schema history shows each migration with columns for rows and duration, which read "—" until the platform records them.
