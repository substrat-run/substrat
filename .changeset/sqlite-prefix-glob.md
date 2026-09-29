---
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/cli': patch
'@substrat-run/model-emit': patch
---

A scope's dump and restore no longer skip a table whose name merely looks like SQLite's reserved `sqlite_` prefix. The filter read `name NOT LIKE 'sqlite_%'`, where `_` matches any character, so a table called `sqlitedata` or `sqlite1` was left out of the export and survived a restore's drop sweep. It now reads `NOT GLOB 'sqlite_*'`, which matches the prefix literally. The directory dump and the CLI's scope read had the same filter.
