---
'@substrat-run/oidc-rp': minor
---

Signing out no longer stops at a "Confirm logout" page.

A federated logout (`/api/auth/logout?federated`) has always sent the issuer a
`client_id` and a `post_logout_redirect_uri` and nothing else. That is the shape
of request an OP cannot tell apart from a link someone was tricked into
following, so OIDC RP-Initiated Logout §2 says it SHOULD stop and ask the person
to confirm — and a spec-faithful provider does, which puts an interstitial in the
middle of what the person already asked for.

The ID token from the login round-trip is now kept and handed back as
`id_token_hint`, which is the mechanism the spec provides for exactly this: the
OP verifies the request against the session the hint names and redirects
straight through. It rides its own cookie scoped to the logout path rather than
a claim in the session, so it travels on one request in the session's life
instead of every one.

Nothing changes for an issuer that advertises no `end_session_endpoint`, or for
a plain (non-federated) logout. A session minted before this version carries no
hint and still sees the confirmation page — correctly, since there is nothing to
verify it against — and the next sign-in puts the hint back.
