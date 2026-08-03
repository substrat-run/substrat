---
'@substrat-run/contracts': minor
'@substrat-run/demo-meridian': patch
---

Auth config no longer shows up twice on the install form. A vertical that
declares `requires: ['oidc-issuer']` gets the dashboard's Identity picker
(Built-in / an Auth Server / External OIDC) — but its `AUTH_PROVIDER`/`OIDC_*`
env fields, which configure the same thing, were *also* rendered right beside
it, so you could pick two contradictory auth answers at once. `envVarSpec`
gains an `identityManaged` flag: a key so marked is auth the Identity picker
owns, hidden from the install form (and its default no longer delivered behind
the picker's back) while staying on the post-install Env tab as the hand-edit
fallback. Meridian marks its three auth keys accordingly.
