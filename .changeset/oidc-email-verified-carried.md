---
'@substrat-run/oidc-rp': minor
'@substrat-run/vertical-auth': minor
---

Carry the issuer's `email_verified` claim through to the session and the auth subject.

An address only says who someone is if the issuer stands behind it, and until now nothing
transported that answer: the claim was read nowhere, so a gate on it could not be written.
`SessionUser.emailVerified` and `AuthSubject.emailVerified` now hold what the issuer said —
`true`, `false`, or `undefined` when it said nothing, which is a different fact from
"unverified" and stays distinguishable end to end. The flag travels with the address it
qualifies, so a UserInfo response never vouches for an address the ID token signed.

Nothing authorizes differently: this is transport, and every existing session keeps working
with the field absent.
