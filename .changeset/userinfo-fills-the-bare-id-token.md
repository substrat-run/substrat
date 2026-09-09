---
'@substrat-run/oidc-rp': minor
---

The RP now reads the profile claims from **UserInfo** when the ID token does not carry
them, instead of quietly ending up with a session that has an id and no address.

We ask for `scope=openid email profile` and used to take the answer from the ID token
alone. That is only half of where OIDC puts it. **OIDC Core §5.4 routes scope-requested
claims to the UserInfo endpoint whenever an access token is issued** — which the
authorization-code flow always does — so a provider is entirely within spec to return an
ID token carrying `sub` and the protocol claims and nothing else. Providers genuinely
split on this: the Auth0 lineage includes the profile anyway and has a compatibility flag
that says so out loud, while a strictly conformant provider does not, and documents that
it does not.

Against the second kind the failure was silent and looked like something else entirely.
The login succeeded, the ID token verified, the session was real — and it carried no
e-mail. Any relying party that resolves a local account **by address** then has no thread
to follow: it derives an identity from the `sub` instead, and the person arrives
authenticated and unrecognised, holding nothing. Every screen answers 403 while the
session endpoint answers 200, so it reads as a broken app or a broken permission model,
and the one place the cause is visible is a claim that isn't in a token nobody prints.

The fetch is deliberately narrow:

- **Only when something is missing.** A provider that already puts the claims in the ID
  token pays no extra round trip and behaves exactly as before.
- **The ID token still wins.** UserInfo fills gaps and never overwrites a claim that was
  signed into the token we verified.
- **`sub` is verified, and a mismatch throws.** OIDC Core §5.3.2 requires that the
  UserInfo `sub` match the ID token's, and that a mismatched response not be used. Not
  using it is the floor; refusing the login says it out loud, consistent with every other
  integrity failure in this flow (state, nonce, signature), because a mismatch is never a
  quirk — it is a response about a different subject.
- **Transport problems degrade rather than fail.** No advertised endpoint, no access
  token, a non-2xx, unreadable JSON: the login stands with whatever the ID token gave.
  The ID token is the authentication; this is enrichment, and enrichment must never be
  able to lock anyone out.

The package gains its first test suite — the round trip against a stubbed issuer, both
provider shapes, the `sub` check, and each way the fetch is allowed to give up.
