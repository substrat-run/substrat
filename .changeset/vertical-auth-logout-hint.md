---
'@substrat-run/vertical-auth': patch
'@substrat-run/oidc-rp': minor
---

A hosted vertical's federated sign-out stops at a "Confirm logout" page no longer.

`oidcRpAuthProvider` — the provider every hosted vertical composes — threw away the ID
token the login round-trip verified, so the only RP-initiated logout it could ask for was
an anonymous one. Without `id_token_hint` an issuer cannot tell a real sign-out from a
link somebody was tricked into following, so OIDC RP-Initiated Logout §2 says it SHOULD
ask the person to confirm, and Better Auth's provider does: an interstitial in the middle
of what the person already asked for.

The provider now keeps that token in its own cookie — scoped to the logout path,
`SameSite=Strict`, the same lifetime as the session — and `GET /api/auth/logout?federated`
hands it back to the issuer, which verifies the request against the session the hint names
and redirects straight through. This is what `mountOidcRoutes` already did for the platform
apps; the two now share one implementation of the rule, `federatedLogoutUrl` in
`@substrat-run/oidc-rp`, rather than a copy each.

Unchanged: a plain `/api/auth/logout` stays local, and the local sign-out still happens
first, so an issuer that is down or advertises no end-session endpoint can only leave its
own session standing. A session minted before this version has no hint and still sees the
confirmation page — the next sign-in puts one there.
