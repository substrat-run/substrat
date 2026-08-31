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

## `instanceAuthFor` — what a vertical actually mounts

A vertical does not pick a provider at build time. One serving script runs every install, and
each install may have been given a different issuer in the dashboard, so the provider is a
function of *this scope's* delivered configuration. `instanceAuthFor` is that whole step —
read the delivered config, parse `substrat:auth`, resolve the declared settings, select a
provider — in one DO hop:

```ts
import { instanceAuthFor, AuthConfigError } from '@substrat-run/vertical-auth';

const instance = await instanceAuthFor({
  directory: identityDo(env, node), // the tenant's IdentityDO stub
  scopeId: node.scopeId,
  envSpec: TICKET0_ENV,             // the vertical's declared env spec
  env,                              // the worker's own bindings
});

// { identity, sessionSecret, settings, config, provider() }
```

| Field | What it is |
|---|---|
| `identity` | the parsed `substrat:auth` choice, or `null` when nothing usable was delivered |
| `sessionSecret` | the tenant's DO-minted session-signing secret |
| `settings` | the declared env spec, resolved **delivered > binding > manifest default** |
| `config` | the whole delivered map, for a vertical's own non-declared keys |
| `provider()` | the `AuthProvider` this instance's configuration selects |

Three things it owns, each of which a caller assembling this by hand gets wrong:

- **`provider` is a function, not a field.** A route that only reads `settings` must not fail
  because nobody has configured a login yet, so selection — and its throw — happens when the
  provider is asked for, not when the config is read.
- **Settings resolve delivered > binding > default.** A spec `default` rides as a binding
  shared by every install of one serving script, so reading `env.OIDC_ISSUER` directly hands
  every tenant the same string no matter what any of them saved in the dashboard. That was a
  real bug in one of the four hand-written copies this replaces.
- **`AuthConfigError` carries its HTTP status with the throw.** An instance nobody has
  configured yet is a `503`; `AUTH_PROVIDER=oidc` with no `OIDC_ISSUER` is a `500`, because a
  deployment that asked for a provider and did not finish configuring it is an operator's
  mistake, not a tenant's missing choice. A plain `Error` would have arrived as a 500 by
  accident. Each worker re-raises it in its own framework's exception:

```ts
try {
  return instance.provider();
} catch (err) {
  if (err instanceof AuthConfigError) throw new HTTPException(err.status, { message: err.message });
  throw err;
}
```

`callout`, `meridian`, `manyfold` and `ticket0` all mount it. The `create-substrat` template
deliberately does **not**: its `config-do.ts` mirrors the same `scope_config` table shape so a
project can swap the binding and adopt vertical-auth later, which is why the scaffold and a
demo look different here.

## What it selects between

`instanceAuthFor` picks one of these; a vertical that runs its own composition can also
construct one directly.

| Export | Login happens | Selected when |
|---|---|---|
| `oidcRpAuthProvider` | server-side, in your worker | a `substrat:auth` choice was delivered — the hosted path, one script and many issuers |
| `oidcAuthProvider` | at the issuer; the app verifies a presented JWT | nothing was delivered and `AUTH_PROVIDER=oidc` names a fixed issuer — standalone deploys, or an SPA already holding a token from Supabase, Auth0, AuthHero, Keycloak, Zitadel |
| `doAuthProvider` | in your own Durable Object | the vertical owns credentials rather than delegating to an issuer (not selected by the composition, which is OIDC-only) |

`oidcAuthProvider` is discovery-driven: the issuer URL is the only wired-in value, and the ID
token is signature-verified against the issuer's JWKS. `oidcRpAuthProvider` runs
Authorization-Code + PKCE through [`@substrat-run/oidc-rp`](/reference/oidc-rp), so verticals
and the platform share one verifier rather than two copies of the security-critical path.
Neither delivered nor defaulted is unconfigured, and the composition fails closed.

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
