---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
---

Clean-room (source-less) previews — a vertical's FIRST environment can be a throwaway
(issue #509 ask (b), the other half of #514).

A preview forked prod, so a brand-new vertical with no prod scope was refused
(`no prod scope to fork — provision one first`, 409) — exactly when a throwaway environment
is most useful. `substrat preview create --tag … --empty` now provisions an **empty** scope
instead of forking: the module tables are migrated (co-located at provision; a dispatch
deployment materializes the empty DO and its `ensureMigrations` creates the schema on first
access), the version binds, and a hostname is minted.

- **Hostname:** with no source scope to derive a URL from, a clean-room preview follows the
  platform tenant-app convention `<vertical>-<tenant>--<tag>.<base>` — the same scheme
  provisioning mints (`callout-sesamy.global.substrat.run`).
- **GC:** a clean-room preview is a `preview` scope with no `forkedFrom`, so the reap sweep
  and `deleteSnapshot` now key off **`kind === 'preview'` OR a fork**, not fork-ness alone —
  the one sanctioned hard-delete invariant widened from "only a fork" to "a fork or a preview".
  A primary scope is still tombstone-only (archive it). This is the one semantics change here.
- `empty` and a `sourceScopeId` are mutually exclusive (400) — the request is refused, never
  silently guessed.

Contract-suite coverage (both adapters): `deleteSnapshot` reaps a non-fork preview, and the GC
sweep reaps an expired one. Control-plane API: a clean-room preview provisions an empty non-fork
scope with the tenant-app hostname and deletes like any preview.
