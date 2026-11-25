---
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/control-plane": patch
---

The daily directory copy can read its append-only and log tables by reference instead of copying them into a snapshot first (`DIRECTORY_BACKUP_BY_REFERENCE`: `off` by default, `verify`, `on`), and every copy now records the directory's point-in-time-recovery bookmark.
