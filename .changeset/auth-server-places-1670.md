---
'@substrat-run/demo-auth-server': minor
---

The auth server's **Your account** page now lists every app the signed-in account is a member of, with a link into each, across every team whose apps sign in with this auth server.

No app can answer "where else am I", because an app never sees another tenant. So the issuer keeps the list, keyed on the `sub` it minted, and serves it at `GET /api/account/places` only to the session it belongs to. The route reads no query string and no body, so there is no way to ask about another account. Each entry is exactly a tenant, a scope, a hostname and a name. The response is `no-store` and grants no cross-origin access.

Two parties write the list, and neither can write the other's half:
- **The platform** registers which apps are places, and under what name and hostname. It does this per team through the platform-gated `/internal/configure` (`substrat:places:<tenant>`). An app that drops out of that set leaves every list at once.
- **The app** reports who is bound in its scope, at `POST /api/places/report`, authenticated as the client the platform registered for it. A client the platform never registered is refused, including any client that registered itself. A client can only touch its own app's entries. An addition is kept only if this issuer has itself signed that account in to that client, so no app can put itself in the list of someone who never used it. Every per-account outcome gets the same answer, so reporting tells the reporter nothing.

The list lives in the issuer's own storage, beside the accounts it is about. The issuer's administrators can see it, just as they already see which applications each account has consented to.
