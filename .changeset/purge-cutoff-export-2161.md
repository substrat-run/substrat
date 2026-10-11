---
'@substrat-run/kernel': minor
---

The kernel index exports `purgeCutoffOf(now, days)`, the latest trash instant still due for purge at `now` (#2161). A vertical's `trashed: 'purges'` handler holds a direct caller to the same horizon as the platform's purge sweep with it, instead of a second clock rule of its own.
