---
'@substrat-run/vertical-auth': minor
'@substrat-run/contracts': minor
'@substrat-run/dev-issuer': minor
'@substrat-run/dashboard': patch
---

A vertical bound to a team auth server accepts only bearer tokens minted for it.

Before, when no `audience` was configured, the relying party's bearer fallback checked only the token's signature and issuer. Every app on a team auth server shares that issuer, and so does any client that registers itself there. So on every route, a vertical accepted another app's `id_token` and an access token requested for another vertical's MCP endpoint. Cookie sessions were never affected.

Now, when the delivered config marks the issuer as shared (`substrat:auth:shared-issuer` = `"true"`, exported as `SHARED_ISSUER_CONFIG_KEY` from `@substrat-run/contracts`), a bearer is accepted only if it is the app's own:

- its `aud` names the app's MCP resource on the origin the request reached (`mcpResourceOf`). That is an MCP client's access token, whatever client requested it.
- its `azp` / `client_id` is the app's client id. Every one that is present must match.
- it has neither claim, and its `aud` is exactly the app's client id. That is the app's own `id_token`. A multi-valued `aud` with no `azp` is refused.

Anything else is a `401`. A configured `audience` still wins, as before. `oidcRpAuthProvider` takes the marker as `sharedIssuer`, and `instanceAuthFor` reads it from the delivered config. `AuthProvider.resolve` takes an optional second argument, the request URL. A caller that omits it (every existing one) gets the origin from the `Host` header.

**Issuers you configured by hand are unchanged.** Supabase, Auth0, Keycloak and the like carry no marker, and their bearers are checked exactly as before. To hold them to one audience, set the connection's `audience` (`authenticated` for a Supabase access token, the API identifier at Auth0).

The dashboard delivers the marker beside `substrat:auth` at install and on an Identity change. Apps installed before this get it the next time anyone on the team opens the Apps list, from the same pass that registers their MCP endpoint. That pass retries on later loads until the marker lands. An existing install is protected once both halves are live: this dashboard, and a deploy of the vertical built against this `vertical-auth`.

The dev issuer's `/dev/token` now mints for `substrat-dev` by default, the client `devLogin` signs in as (it was `dev`), and `devLogin` applies the team rule, so a script that works locally works hosted. A script that passed `audience: 'dev'` explicitly, or that points `devLogin` at another client id with `OIDC_CLIENT_ID`, must now mint for that client id. `DEV_CLIENT_ID` is exported.
