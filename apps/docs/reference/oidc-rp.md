# @substrat-run/oidc-rp

The Substrat platform's OpenID Connect **relying party** — written once so the
security-critical verifier is not copied per app. The [Dashboard](/platform/dashboard) and the
[control-plane Console](/platform/console) both authenticate through it; the `substrat login`
CLI brokers the same flow. It proves *who* a caller is (the ID token `sub`, and `email`) and
nothing more — [authorization stays in the kernel](/concepts/permissions): roles, grants, and
tenancy are never this package's concern.

It is the concrete form of the [identity seam](/concepts/identity#two-real-choices-made-differently)
for the platform's own surfaces. The demo verticals are OIDC-only relying parties too, through
[`@substrat-run/vertical-auth`](/reference/vertical-auth), against whatever issuer they are
pointed at; none keeps a credential store, and `demos/auth-server` is the only workspace
member that runs Better Auth — as an issuer. The platform apps share this one relying party
against AuthHero.

## What it is

- **Standard Authorization-Code + PKCE**, against the platform's AuthHero instance (an
  Auth0-compatible OIDC authority).
- **Discovery-driven.** The only wired-in value is the issuer URL; endpoints and signing keys
  come from `{issuer}/.well-known/openid-configuration`. The ID token is signature-verified
  against the issuer JWKS.
- **Confidential client** — the code-for-token exchange happens server-side with the client
  secret, never in the browser.
- **Stateless.** No KV, no D1. The short-lived PKCE/state/nonce rides a signed *flow* cookie
  (`sb_oidc_flow`, 10-minute lifetime); the session is a signed JWT cookie (`sb_session`,
  7-day lifetime). Both are HMAC-signed with `SESSION_SECRET`.
- **workerd-safe** — `jose` + Web Crypto only, no `node:*`. It runs in the same isolate as the
  app that mounts it.

## Config is entirely runtime

Nothing is checked in; every value is a secret:

```
OIDC_ISSUER          # e.g. https://auth.substrat.run — the only wired-in value
OIDC_CLIENT_ID
OIDC_CLIENT_SECRET   # wrangler secret put …
SESSION_SECRET       # signs the flow + session cookies
BASE_URL             # optional — force the redirect origin, else derive from the request
```

## Surface

The high-level entry point is `mountOidcRoutes(app, opts?)`, which wires three routes onto a
Hono app — identically for both platform apps, because the only per-app difference is what
happens *after* a session exists:

```ts
import { mountOidcRoutes, sessionFromHeaders } from '@substrat-run/oidc-rp';

mountOidcRoutes(app, { onSuccess: '/', onError: '/?error=auth' });
// mounts:  GET /api/auth/login  ·  GET /api/auth/callback  ·  GET /api/auth/logout

// elsewhere, resolve the current user from a request:
const user = await sessionFromHeaders(c.env, c.req.raw.headers); // SessionUser | null
```

The per-app step that stays in the app is exactly the interesting one: the Dashboard does a
**JIT tenant bootstrap** on first login (a new user provisions their own tenant), while the
Console does a **staff-roster lookup** (only a known staff actor gets in). Same session, two
admission policies.

Lower-level pieces are exported for callers that don't want the mounted routes — `beginLogin` /
`completeLogin` (the two halves of the round-trip), `mintSession` / `verifySession`,
`sessionFromHeaders`, and `safePath` (the open-redirect guard that permits only a same-origin
absolute path for a `returnTo`).

## Status

Real and in production — it is what signs you in to the platform apps today. `0.x`: the surface
is stable enough that two apps share it unchanged, but versioned as pre-1.0 until the platform's
own auth surface settles.
