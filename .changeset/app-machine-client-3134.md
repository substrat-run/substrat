---
'@substrat-run/contracts': minor
'@substrat-run/cli': minor
'@substrat-run/demo-auth-server': patch
---

An app can declare the issuer scopes its machine client needs, as `substrat.issuerScopes` in package.json (for example `["read:users", "users:provision"]`), and `substrat push` carries the declaration in the manifest. A sign-in scope or a malformed one is refused before upload. The team auth-server gains the two platform-gated routes that register, converge and remove one machine client per app, bounded by `MACHINE_SCOPES`. Nothing registers a client at install yet: the dashboard half follows.
