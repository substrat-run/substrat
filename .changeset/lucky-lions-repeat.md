---
'@substrat-run/vertical-auth': minor
---

`oidcRpAuthProvider` forwards `prompt` to the issuer

`/api/auth/login?prompt=select_account` (and `prompt=login`) now reaches the authorize
endpoint, as it already did through `mountOidcRoutes`. Without it a vertical had no way to
offer "sign in as someone else": an issuer holding a live SSO session silently
re-authenticates the same user, so the button appears to do nothing. Allowlisted to the two
IdP-recognised values; absent `prompt` behaves exactly as before.
