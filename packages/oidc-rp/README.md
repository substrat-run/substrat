# @substrat-run/oidc-rp

The [Substrat](https://github.com/substrat-run/substrat) platform's OpenID Connect **relying
party** — written once so the security-critical verifier is not copied per app.

The Dashboard and the control-plane Console both authenticate through it, the `substrat login`
CLI brokers the same flow, and
[`@substrat-run/vertical-auth`](https://npmjs.com/package/@substrat-run/vertical-auth) builds
its RP provider on it. It proves *who* a caller is — the ID token `sub`, and `email` — and
nothing more; [authorization stays in the kernel](https://substrat.net/concepts/permissions).

**Full documentation: https://substrat.net/reference/oidc-rp**

## What it is

- **Standard Authorization-Code + PKCE** against any OIDC authority.
- **Discovery-driven.** The only wired-in value is the issuer URL; endpoints and signing keys
  come from `{issuer}/.well-known/openid-configuration`, and the ID token is signature-verified
  against the issuer JWKS.
- **Confidential client** — the code-for-token exchange happens server-side with the client
  secret, never in the browser.
- **Stateless.** No KV, no D1. The short-lived PKCE/state/nonce rides a signed *flow* cookie
  (`sb_oidc_flow`, 10 minutes); the session is a signed JWT cookie (`sb_session`, 7 days). Both
  are HMAC-signed with `SESSION_SECRET`.
- **workerd-safe** — `jose` + Web Crypto only, no `node:*`. It runs in the same isolate as the
  app that mounts it.

## Using it

Mount the routes on a Hono app, then read the session on each request:

```ts
import { mountOidcRoutes, sessionFromHeaders, type OidcEnv } from '@substrat-run/oidc-rp';

mountOidcRoutes(app);                                  // /login, /callback, /logout
const user = await sessionFromHeaders(env, req.headers); // SessionUser | null
```

`beginLogin` / `completeLogin` / `verifySession` are exported for callers that own their own
routing — that is how `vertical-auth` wraps the same flow behind its `AuthProvider` interface.

## Config is entirely runtime

Nothing is checked in; every value is a secret:

```
OIDC_ISSUER          # the only wired-in value
OIDC_CLIENT_ID
OIDC_CLIENT_SECRET   # wrangler secret put …
SESSION_SECRET       # signs the flow + session cookies
BASE_URL             # optional — force the redirect origin, else derive from the request
```

`hono` is a peer dependency, needed only for `mountOidcRoutes`.

## Status

Pre-release (0.x): interfaces change without notice until the first vertical ships.
