---
'@substrat-run/dashboard': minor
'@substrat-run/dashboard-web': minor
---

Export & import from the dashboard (preview-and-snapshots.md §8's dashboard half):
the Snapshots tab grows an Export & import card. Export downloads the app's data as
a `.dump.json` the CLI's `scope restore` also accepts — in connected mode it arrives
PII-masked from the control plane's governed export route (the full-fidelity
break-glass stays a CLI/staff affordance); embedded mode returns the full read
(`masked: false`), since the host's files already sit on the operator's own disk.
Import replaces the app's data wholesale with an uploaded dump (a pulled export or a
locally built world), always forking a TTL'd safety copy first so the pre-restore
state survives as a snapshot to back out to. Both halves gate on
`dashboard:provision-app` in the caller's own scope and land on the app's activity
trail as `data-exported` / `data-restored` (migration 0008 widens the event CHECK,
rebuild-and-copy like 0005/0007). New tenant-narrowed CP wrappers `exportScope` /
`restoreScope` reach the existing staff routes over the service binding.
