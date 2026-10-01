---
'@substrat-run/cli': patch
---

Scope restore now sends the backup's original tenant, scope, and capture time when available. JSON dumps retain their metadata, and SQLite backups use the IDs in their standard filenames. Restores from files without origin IDs explicitly report that they use the target as a fallback.
