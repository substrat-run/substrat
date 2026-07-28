---
'@substrat-run/dashboard': patch
---

The app Identity settings no longer refuse a save (or hide the callback URL) when the
dashboard's own hostname bookkeeping is empty for a fully-reachable app (#294). The
Settings → Identity card derived the OIDC callback URL solely from the `dashboard_apps.hostname`
column, so an app that the router serves — and that redirects to OIDC correctly — but whose
column is null would answer the save with *"this app has no hostname yet"* and show the card
as builtin. That column can be null even for a live app.

- **The dashboard now reads the hostname from the authoritative source when its own copy is
  empty.** A new `resolveDefaultHostname` prefers the stored column but falls back to the app's
  live router bindings (the same control-plane read the Domains tab already uses), picking the
  canonical, active one. Both `/api/apps/:scope/auth` routes use it, so the callback URL forms —
  and the save succeeds — whenever the app genuinely has a hostname bound, regardless of whether
  the dashboard happened to record it.

- **Provisioning stops discarding a hostname it successfully bound.** In both the connected and
  embedded paths the primary `bindHostname` and its follow-up `setHostnameStatus`/secondary-surface
  binds shared one `try` whose `catch` swallowed everything and returned null — so a transient
  activation error after a successful bind stranded the dashboard's record (a null column) while
  the app ran fine. Once the primary bind succeeds the hostname is now returned regardless of any
  best-effort step failing after it.
