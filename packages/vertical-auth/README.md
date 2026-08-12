# @substrat-run/vertical-auth

Pluggable auth for [Substrat](https://github.com/substrat-run/substrat) verticals — one
interface the app codes against, and three interchangeable implementations behind it.

A vertical scaffolded with [`create-substrat`](https://npmjs.com/package/create-substrat)
answers `/api/*` with `401` until real auth is wired into `authenticatedPrincipal`. This is
the package that fills that seam.

**Full documentation: https://substrat.net/reference/vertical-auth**

## The contract

`AuthProvider` is the only identity type the application depends on. It proves *who* a caller
is and nothing more — [authorization stays in the kernel](https://substrat.net/concepts/permissions):
roles, grants, and tenancy are never this package's concern.

```ts
import type { AuthProvider, AuthSubject } from '@substrat-run/vertical-auth';

interface AuthProvider {
  handle(request: Request): Promise<Response>;     // /api/auth/* — login, logout, callbacks
  resolve(headers: Headers): Promise<AuthSubject | null>; // request → verified subject
}
```

`AuthSubject` carries the provider's stable `sub` plus `email`/`name`. Mapping that `sub` to a
Substrat `PrincipalId` is a **separate, per-scope concern** — the identity directory below —
so swapping the implementation never touches the app.

## Three implementations

- **`oidcAuthProvider`** — token-based. The SPA logs in at the issuer and presents a JWT; this
  verifies it against the issuer's JWKS. Covers Supabase, Auth0, AuthHero, Keycloak, Zitadel
  identically. Discovery-driven, so the issuer URL is the only wired-in value.
- **`oidcRpAuthProvider`** — the full relying-party browser flow: server-side
  Authorization-Code + PKCE, session cookie, `returnTo` handling. Built on
  [`@substrat-run/oidc-rp`](https://npmjs.com/package/@substrat-run/oidc-rp), the same verifier
  the platform's own surfaces use.
- **`doAuthProvider`** — Better Auth running inside the per-tenant `IdentityDO`, for verticals
  that own their credentials rather than delegating to an issuer.

## The identity directory

`IdentityDO` is one Durable Object **per tenant**, running its own SQLite. A tenant's users,
sessions, and credentials live in that tenant's DO — there is no shared `AUTH_DB` for a bug to
leak across tenants. It holds the provider-agnostic `sub → principal` mapping, so
`setPendingOwner` / `resolvePrincipal` are used under **every** provider, including the two
OIDC ones where Better Auth stays dormant.

That mapping is what makes first-run ownership work: the first authenticated subject claims
the pending owner slot, and access is invite-only afterwards.

Also exported: `resolveCookieDomain`, which refuses to set a session cookie on a public suffix
(guarded by [`@substrat-run/psl`](https://npmjs.com/package/@substrat-run/psl)).

## Runtime

Workers-targeted: `jose` + Web Crypto, no `node:*`. `IdentityDO` extends the
`cloudflare:workers` `DurableObject` base, and the vertical's worker bundles this package and
exports the DO class for wrangler.

## Related packages

- [`@substrat-run/oidc-rp`](https://npmjs.com/package/@substrat-run/oidc-rp) — the relying
  party behind `oidcRpAuthProvider`
- [`@substrat-run/vertical-host`](https://npmjs.com/package/@substrat-run/vertical-host) — the
  platform surface a hosted vertical mounts
- [`@substrat-run/psl`](https://npmjs.com/package/@substrat-run/psl) — the cookie-domain guard

## Status

Pre-release (0.x): interfaces change without notice until the first vertical ships.
