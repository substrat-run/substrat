---
'@substrat-run/demo-auth-server': minor
---

Sign in with a Supabase project that is still on the legacy shared JWT secret. Such a
project cannot be added as an ordinary sign-in provider, and not by our choice: Supabase
will not mint the OIDC id_token that the redirect flow needs while signing with HS256, so
the catalogue entry simply cannot serve it. Instead the issuer can now accept an access
token that project already issued to its own app, at one endpoint that exists only when an
operator has configured both the secret and the project URL. The person lands in the same
account they would have reached through the redirect flow — the account is keyed on the
project and Supabase's own user id — so migrating the project to asymmetric signing keys
later moves nobody and changes no relying party's view of who they are. What the issuer
refuses is the part worth knowing about: on a legacy project the JWT secret signs more than
people, and the project's public `anon` key — the one printed in its own browser bundle —
is itself a valid signature. That key, the `service_role` admin key, any unfamiliar role,
an anonymous session, another project's token and anything not signed with HS256 are all
turned away, and every one of those says the same thing to the caller, so the endpoint cannot
be used to probe which check a token failed. A token that verifies but is turned away by
policy — sign-up closed, or an address that already has an account — says which, because the
person reading it has proved the token and can act on the answer. Whether someone arriving at an address that already has an
account here is joined to it or refused is the issuer's existing account-linking setting,
applied to this door too.
