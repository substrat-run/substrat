---
'@substrat-run/oidc-rp': patch
'@substrat-run/vertical-auth': patch
---

A federated logout with a `returnTo` no longer fails at the issuer with `Invalid post_logout_redirect_uri`. Issuers match that URI exactly against the client's allowed logout URLs, so a `returnTo` that differs per request (an invite link's `/invite/<token>`) could never be registered. The issuer is now given one fixed URL, `/api/auth/logged-out`, and the path the person was heading for waits in a short-lived `sb_oidc_return` cookie until they arrive there (same-origin paths only). A logout with no `returnTo` still sends `/` as before. `oidc-rp` exports `federatedLogout`, `LOGGED_OUT_PATH` and `LOGOUT_RETURN_COOKIE`, and `vertical-auth` serves the new route. **Action:** register `<origin>/api/auth/logged-out` as an allowed logout URL on the OIDC client.
