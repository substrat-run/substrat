---
"@substrat-run/oidc-rp": minor
"@substrat-run/console": patch
"@substrat-run/dashboard": patch
"@substrat-run/builder": patch
---

A second sign-in issuer, reached by asking for it. Set `OIDC_ALT_ISSUER`, `OIDC_ALT_CLIENT_ID` and `OIDC_ALT_CLIENT_SECRET` on an app that mounts `mountOidcRoutes`, and `/api/auth/login?idp=alt` signs in through that issuer while a plain login stays on `OIDC_ISSUER`. The choice is carried in the signed flow cookie, so the callback verifies the ID token against the issuer the person was sent to, and sign-out ends the session at the issuer that made it. Asking for `alt` where the three values are not all set is refused rather than falling back to the default. The Console, the Dashboard and the builder studio pass `?idp=alt` from the address they were opened at on to the login route. `beginLogin` takes an optional `idp`; `envForIdp` and `idpOf` are exported.
