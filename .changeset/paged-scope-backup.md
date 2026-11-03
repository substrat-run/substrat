---
'@substrat-run/control-plane-api': minor
---

A scope backup is read and stored a page at a time, so a scope past one Durable Object call can be backed up and reaped with a backup; `POST …/backups/:capturedAt/restore` restores a held backup, and the backup store seam is now `begin`, `list` and `get`, which reads a backup entry by entry.
