# @substrat-run/demo-manyfold

## 0.1.8

### Patch Changes

- bc6d0fa: In-place deploys (#286, K-33): version updates carry scope data forward. Verticals now
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
- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0
  - @substrat-run/adapter-cloudflare@0.22.0
  - @substrat-run/adapter-sqlite@0.22.0

## 0.1.7

### Patch Changes

- Updated dependencies [3354e26]
  - @substrat-run/adapter-cloudflare@0.21.0
  - @substrat-run/contracts@0.21.0
  - @substrat-run/kernel@0.21.0
  - @substrat-run/adapter-sqlite@0.21.0

## 0.1.6

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0
  - @substrat-run/adapter-sqlite@0.20.0
  - @substrat-run/adapter-cloudflare@0.20.0

## 0.1.5

### Patch Changes

- Updated dependencies [b4a6bee]
- Updated dependencies [83aa7fd]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/adapter-cloudflare@0.19.0
  - @substrat-run/kernel@0.19.0
  - @substrat-run/adapter-sqlite@0.19.0

## 0.1.4

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0
  - @substrat-run/adapter-sqlite@0.18.0
  - @substrat-run/adapter-cloudflare@0.18.0

## 0.1.3

### Patch Changes

- @substrat-run/contracts@0.17.0
- @substrat-run/kernel@0.17.0
- @substrat-run/adapter-sqlite@0.17.0
- @substrat-run/adapter-cloudflare@0.17.0

## 0.1.2

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [b2ab362]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0
  - @substrat-run/adapter-sqlite@0.16.0
  - @substrat-run/adapter-cloudflare@0.16.0
  - @substrat-run/vertical-auth@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [cd32011]
- Updated dependencies [d93e690]
- Updated dependencies [ec89a88]
  - @substrat-run/adapter-cloudflare@0.15.0
  - @substrat-run/adapter-sqlite@0.15.0
  - @substrat-run/contracts@0.15.0
  - @substrat-run/vertical-auth@0.2.0
  - @substrat-run/kernel@0.15.0

## 0.1.0

### Minor Changes

- 21ebd1e: **Manyfold — a multi-scope headless CMS demo vertical.** A sandbox-clean, deployable vertical
  where **site = scope**: one install, many sites. The vertical owns the editorial lifecycle
  (draft→in_review→approved→published state machine that can't skip, append-only revisions,
  freeze-on-publish with a content hash, a delivery surface that resolves references — a
  draft/archived target comes back explicitly unresolved). **Content types are data**, authored
  in a model builder (`save-type`/`list-types`), each compiling to a reviewable migration
  (never a live ALTER); bodies persist as JSON so adding a field is free.

  Ships the full app: content editor + workflow, the model builder (models, field editor,
  relationship map, migration preview), and Members & roles — all URL-routed so a refresh
  restores the view. Auth is the tenant's own `IdentityDO` (Better Auth): first sign-in claims
  the owner seat (→ admin), then **member invites** (mint a principal, grant a role at scope
  level, share an accept link) open the post-setup join path. The deployable worker is
  sandbox-clean (own `ScopeDO` + `IdentityDO`, SPA inlined, no privileged bindings).

  Also fixes permission-denial status on the Cloudflare DO adapter: an op's error crosses the
  `ScopeDO` RPC boundary and is rebuilt as a plain `Error`, so `instanceof PermissionDenied`
  was false and denials degraded to 400 — now matched by message too, so denials are 403 on
  the worker as in node.

  Registers Manyfold in the dashboard catalog (`connected`) and bundles its module in the
  dashboard worker.

### Patch Changes

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0
  - @substrat-run/adapter-sqlite@0.14.0
  - @substrat-run/adapter-cloudflare@0.14.0
  - @substrat-run/kernel@0.14.0
