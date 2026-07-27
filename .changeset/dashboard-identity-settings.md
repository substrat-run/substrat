---
'@substrat-run/dashboard': minor
---

The app's Identity choice is visible and editable after install, and identity failures
read as instructions. Install now AUTHORS the delivered `substrat:auth` config in the
dashboard's own store (new `dashboard/set-app-auth` / `dashboard/get-app-auth` ops on the
reserved `substrat:*` key namespace, hidden from the Env tab), so a Settings-tab Identity
card can show the wired issuer and client id — clientSecret write-only, blank keeps the
stored one — and switch issuers via `PUT /api/apps/:scopeId/auth`, which reports honestly
whether the running app received the change (`delivered: false` + a readable note when the
deployment answers 501, instead of an error or a silent fake success). A failed identity
step at install now records an ACTIONABLE reason on the Activity trail — a 501 from the
app's deployment (no live-config support, the sesamy-crm incident) says to retry with
Builtin identity or add `/internal/configure` to the vertical, rather than relaying the
deployment's bare status line.
