---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': patch
---

A version's SQL migrations are now stored apart from its deploy manifest. Reading a version no longer moves its SQL. Admitting, promoting, binding and serving a version read only the manifest, and the promote review reads the SQL on its own.

`substrat push` sends the same manifest as before. The control plane takes the `migrations` field out when the version is published, stores each migration as its own row, and keeps the manifest without it. A set over the push's limits (2000 migrations, 512 KiB of SQL), or one not shaped like migrations, is dropped. The version still publishes, and the promote dialog says the SQL is not available and asks for the acknowledgement. Before, a manifest that large could fail to store after the script had already been uploaded.

Versions pushed earlier are moved over in the background, a few at a time, and read correctly while they wait. A version pushed before manifests carried migrations still reads as "SQL not available", never as "no migrations". A directory restored from a backup taken before the move is moved again.

`HostAdmin` gains `versionMigrations(actor, verticalSlug, versionId)`, which returns one version's migrations in the order the host runs them. It returns `null` for a version with none to show. Like `versionManifest`, it refuses a version of another vertical. Anything that implements `HostAdmin` needs the new method.
