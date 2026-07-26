---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/contracts': patch
'@substrat-run/contract-tests': patch
'@substrat-run/dashboard': minor
---

Marketplace apps/verticals split + the empty-marketplace fix.

**Adapters:** `registerVertical` now refreshes `listed` on an identical re-registration
of a **builtin** vertical (it is seed metadata, derived from the catalog's `connected`
flag). Rows registered before the `listed` column existed (migration default 0) were
stuck unlisted forever, so the hosted marketplace rendered empty. A pushed (`cli`/`git`)
vertical's `listed` stays untouched — re-pushing a published vertical still cannot
silently unpublish it.

**Dashboard:** the create-app page is now pure instantiation, grouped **Marketplace**
(published) and **Your verticals** (your team's own, badged Private/Published, disabled
until a version is promoted to prod). The Deployments page is renamed **Verticals**
(`#/deployments` stays as an alias) and takes over the supply side: the GitHub
import + one-click CI scaffold move there from create-app. `GET /api/catalog` returns
`{owned, listed, source, installable}` and, in connected mode, merges the shared
control plane's registry — so a pushed vertical shows up and (via the same fallback in
`installSpecFor`) installs in production, not just embedded mode.
