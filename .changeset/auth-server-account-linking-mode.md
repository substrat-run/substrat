---
'@substrat-run/demo-auth-server': minor
---

Decide what an upstream sign-in may do with an address that already has an account here.
A new issuer-wide setting, `ACCOUNT_LINKING`, beside the sign-up toggle and settable the
same three ways: `link` lets the sign-in join that account — on Better Auth's own two
conditions, the upstream vouching for the address (or the provider being trusted here) and
the local account having a verified one — and `block` never joins implicitly, leaving the
person to sign in the way they already can and connect the provider from inside that
session. It defaults to `link`, which is what the issuer did before the key existed:
unlike the sign-up toggle this one defaults permissive on purpose, because a setting that
silently changes how people sign in on upgrade is worse than one you have to turn on.
`block` is careful about two things it does not do, each held by a test: it leaves the
deliberate connect alone, since a session proves the account in a way a matching address
does not, and it leaves alone an upstream identity that matches no account here, since a
newcomer is not a join. There is no third mode, and the missing one is the one most
identity providers offer: keeping two separate accounts on one address. Better Auth
resolves an email to exactly one user — in password sign-in, password reset, recovery and
account creation alike — so a second account at that address would make each of those pick
one arbitrarily. Both the setting's description and the dashboard say so, rather than
leaving the absence to look like an oversight.
