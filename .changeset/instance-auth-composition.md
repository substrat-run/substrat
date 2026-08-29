---
'@substrat-run/vertical-auth': minor
---

New `instanceAuthFor` — the composition four verticals were each writing for themselves:
read an instance's delivered config in one DO hop, parse the `substrat:auth` choice,
resolve the declared settings (delivered > binding > manifest default), and select the
`AuthProvider`. Exported alongside `parseAuthChoice`, `selectAuthProvider`,
`AUTH_CONFIG_KEY` and `AuthConfigError` (which carries the status an unconfigured instance
should answer with). Purely additive — the primitives it composes are unchanged.
