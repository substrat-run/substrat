---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/demo-meridian': patch
'@substrat-run/demo-manyfold': patch
---

In-place deploys (#286, K-33): version updates carry scope data forward. Verticals now
serve from ONE stable dispatch script per vertical — a prod promote re-uploads the
promoted version's bundle onto that unchanged name (modules read back from the
per-version archive script, metadata from the version's retained manifest), so scope
DOs and their data stay put while the code moves, and kernel migrations finally run in
place. In-place uploads keep existing secrets (`keep_bindings`) and send only the
DO-class delta, diffed against directory-recorded serving state. Routing is per-scope
truth (`scopes.servingRef`, COALESCEd over the bound version's ref); new scopes are
born on the serving script, legacy scopes hop once via the new adopt-serving endpoint
(export → restore → flip, data-first). Safety net: versions carry a code-only vs
schema-change signal (migration-digest diff), the scope DO takes a PITR bookmark
immediately before an upgrade's migration pass, and a new audited, time-boxed rewind
(`rewindScope`, 24h window unless forced) restores schema and data to that instant.
New `/internal/bookmarks`, `/internal/rewind` (and Meridian's previously missing
`/internal/restore`) vertical routes; new `HostAdmin` methods (`verticalServing`,
`setVerticalServing`, `versionManifest`, `setScopeServingRef`,
`scopeMigrationBookmarks`, `rewindScope`).
