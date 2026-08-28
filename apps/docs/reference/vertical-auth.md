# @substrat-run/vertical-auth

Pluggable authentication for a vertical — **one interface the application codes against**, and
three interchangeable implementations behind it. It is the concrete form of the
[identity seam](/concepts/identity) for verticals, the counterpart to
[`@substrat-run/oidc-rp`](/reference/oidc-rp), which serves the platform's own surfaces.

A vertical scaffolded with `create-substrat` answers `/api/*` with `401` until real auth is
wired into `authenticatedPrincipal`. This package fills that seam without the vertical
hand-rolling session handling or the owner-claim logic.

## The `AuthProvider` contract

```ts
import type { AuthProvider, AuthSubject } from '@substrat-run/vertical-auth';

interface AuthProvider {
  handle(request: Request): Promise<Response>;             // /api/auth/* — login, logout, callbacks
  resolve(headers: Headers): Promise<AuthSubject | null>;  // request → verified subject
}

interface AuthSubject {
  sub: string;           // the provider's stable subject id
  email: string | null;
  name: string | null;
}
```

The provider proves *who* a caller is and nothing more. [Authorization stays in the
kernel](/concepts/permissions) — roles, grants and tenancy are never this package's concern.
Mapping `sub` to a Substrat `PrincipalId` is a **separate, per-scope** step (the identity
directory below), which is what lets the implementation swap without touching the app.

## Choosing an implementation

| Export | Login happens | Use when |
|---|---|---|
| `oidcAuthProvider` | at the issuer; the app verifies a presented JWT | an SPA already holds a token from Supabase, Auth0, AuthHero, Keycloak, Zitadel |
| `oidcRpAuthProvider` | server-side, in your worker | you want the full browser redirect flow and a session cookie you control |
| `doAuthProvider` | in your own Durable Object | the vertical owns credentials rather than delegating to an issuer |

`oidcAuthProvider` is discovery-driven: the issuer URL is the only wired-in value, and the ID
token is signature-verified against the issuer's JWKS. `oidcRpAuthProvider` runs
Authorization-Code + PKCE through [`@substrat-run/oidc-rp`](/reference/oidc-rp), so verticals
and the platform share one verifier rather than two copies of the security-critical path.

## The identity directory

`IdentityDO` is one Durable Object **per tenant**, running its own SQLite. A tenant's users,
sessions and credentials live in that tenant's DO — there is no shared `AUTH_DB` for a bug to
leak across. It is one of the vertical's own DO classes, so it stays
[sandbox-clean](/concepts/deploying): the platform refuses cross-script bindings, not a
vertical's own.

Its `sub → principal` mapping is **provider-agnostic** and used under *every* provider,
including the two OIDC ones where Better Auth stays dormant:

- `setPendingOwner` — records the owner seat at provision. The seat is minted **empty** (the
  platform knows the principal it minted, not the login the tenant's issuer will emit) and
  bound later by a verified subject. For 15 minutes after provision the first authenticated
  subject claims it — the install flow, where the installer opens the app seconds later. After
  that a plain sign-in binds nobody, so an instance nobody opened is not a seat anyone can
  take indefinitely. A re-provision keeps the window it has and never re-opens a claimed seat.
- `resolvePrincipal` — the per-request lookup that turns a verified `sub` into the
  `PrincipalId` the kernel checks permissions against (and performs the first-sign-in claim
  while the window is open).
- `ownerSeat` / `mintOwnerClaim` / `claimOwner` — the claim link. Once the window has closed
  (or instead of relying on it), the platform mints a short-lived `/?claim=<token>` link under
  its secret — the dashboard's *Owner seat* card — and `claimOwner` binds the subject that
  presents it. Only the token's hash is stored; minting again retires the earlier link.
  `mintOwnerClaimLink` does the token, the hash and the URL in one call, so the vertical's
  `mintOwnerClaim` hook is a one-liner. A closed window is not a lost instance: the seat stays
  pending — `needsSetup` keeps saying so, and `ownerSeat` says *why* — until a claim binds it.

## Cookie-domain safety

`resolveCookieDomain` decides the session cookie's `Domain` for multi-surface installs, and
refuses to set one on a public suffix — the boundary where one tenant's cookie could reach
another. It is guarded by the real Public Suffix List via [`@substrat-run/psl`](/reference/psl),
not a label-count heuristic.

## Runtime

Workers-targeted: `jose` + Web Crypto, no `node:*`. `IdentityDO` extends the
`cloudflare:workers` `DurableObject` base, and the vertical's worker bundles this package and
re-exports the DO class so wrangler can see it.
