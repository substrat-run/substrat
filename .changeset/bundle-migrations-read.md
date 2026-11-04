---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': minor
---

The control plane can read the migrations a pushed bundle registers (#2351): a `defineScopeDO` class exposes them under `REGISTERED_MIGRATIONS`, `loaderMigrationExtractor` evaluates a bundle in a Worker Loader isolate with no bindings and no network, and with the `extractMigrations` option a push whose declared migrations differ, or whose worker entry cannot be evaluated, is refused before upload. A version pushed earlier is read at its first promote. Both directories record the digest of what was read (`versionMigrationsExtracted`), and the promote review says whether its migrations were read from the bundle.
