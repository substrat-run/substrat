# @substrat-run/vertical-auth

## 0.2.0

### Minor Changes

- d93e690: Detachable vertical auth (docs/design/vertical-auth-detach.md): auth moves out of the
  verticals and becomes an install-time choice — a team Auth Server app or any external
  OIDC issuer — with `builtin` (embedded Better Auth) as the unchanged default.

  **auth-server** is now a real multi-instance vertical: one issuer DO per scope behind
  the router (own users, signing secret, JWKS per install), the fixed-name single issuer
  standalone. It implements the K-31 surface (`/internal/provision`, `/internal/configure`)
  and answers unknown `/internal/*` paths with JSON — never the SPA fallback that
  surfaced as "Provisioning failed — internal error".

  **Config delivery seam** (control-plane-api): `VerticalClient.configureInstance` +
  `POST /tenants/:t/scopes/:s/configure` deliver per-instance config to the deployment
  holding the scope's DO (bound-version resolution, 501 when there is nowhere to deliver);
  `ProvisionInstanceInput` gains optional `config` so an app arrives configured
  atomically. The dashboard Env tab now delivers after authoring (`delivered` flag).

  **RP flow** (vertical-auth): `oidcRpAuthProvider` — the full server-side
  Authorization-Code + PKCE relying party as an `AuthProvider`, cookie sessions signed
  with a per-tenant DO-minted secret, bearer fallback for API clients. The IdentityDO
  stores platform-delivered per-scope config and keeps the provider-agnostic
  `sub → principal` directory (TOFU owner claim + invites) under every mode. Meridian
  selects its provider per scope from the delivered `substrat:auth`; its SPA renders a
  redirect sign-in and invite-accept in OIDC mode. jose is bumped to v6 so node JWKS
  fetching goes through `fetch`, matching workerd.

  **Install-time identity** (dashboard): the New-app form's Identity section — builtin,
  a team Auth Server (the app is auto-registered there via RFC 7591 dynamic client
  registration against its real bound hostname), or an external issuer. Wiring failures
  mark the app failed with the reason on its audit trail.

### Patch Changes

- Updated dependencies [d93e690]
  - @substrat-run/oidc-rp@0.3.0

## 0.1.0

### Minor Changes

- 12acc59: **First-run setup state + invite-only sign-up (Phase 1).** A freshly-provisioned instance
  now has an explicit setup state instead of a bare login: the IdentityDO exposes
  `needsSetup(scopeId)` (the owner seat is still unclaimed), and Meridian uses it to

  - serve a **"Set up your workspace — create the admin account"** screen on first visit
    (`/api/me` returns `{ status: 'needs-setup' }` while unclaimed), instead of a plain
    sign-in that gives no hint the first sign-up becomes the admin; and
  - **close open sign-up once the admin has claimed it** — after first-run, a stranger who
    finds the URL can no longer self-register (`/api/auth/sign-up/email` returns 403). The
    window is exactly "owner unclaimed", so it closes the instant the admin is created.

  The claim itself is unchanged (trust-on-first-use — first completed setup wins). The
  member-invite path (how teammates join after setup) is the Phase 2 follow-up.

- fa0707c: **Member invites (Phase 2) — the post-setup join path.** Once a workspace is set up it's
  invite-only; this adds the flow that lets teammates in:

  - **IdentityDO** gains an `invite` directory (token _hash_ only) + `createInvite` /
    `listInvites` / `inviteExists` / `revokeInvite` / `claimInvite`. Claiming binds the
    invitee's subject to a pre-minted member principal.
  - **`CloudflareScopeHost.assignScopeRole(scopeId, principal, roleKey)`** — the member half
    of `provisionScopeLocal`'s owner grant: grant a principal a role at scope level so its
    permissions resolve from the scope's own storage (covered by two new workerd tests).
  - **Meridian**: admin-only `POST/GET /api/invites` (+ `…/revoke`) mint/list invites (role
    granted at creation, one-time accept link returned, plaintext token never stored);
    `POST /api/accept-invite` claims one while signed in; the sign-up gate also opens for a
    valid `?invite=` token. SPA: an admin **Access** tab (invite at a role, copy the link,
    revoke) and an **AcceptInvite** screen driven by `?invite=<token>`.

  Roles a teammate can be invited at are this vertical's roles (hr-admin | manager | payroll);
  employees (HR records) remain separate.

- 6a0e253: **Pluggable, config-selected auth for verticals — a new `@substrat-run/vertical-auth` package, and Meridian on it.**

  Auth is now a config choice behind a small contract, isolated per tenant, with no shared `AUTH_DB`.

  - **`@substrat-run/vertical-auth`** (new): the `AuthProvider` contract (`handle` + `resolve`); an
    OIDC provider (`oidcAuthProvider` — verifies a bearer JWT against the issuer's JWKS, covering
    Supabase, Auth0, AuthHero, Keycloak); and a per-tenant **`IdentityDO`** — Better Auth over
    `drizzle-orm/durable-sqlite` (its own SQLite, one DO per tenant) plus the provider-agnostic
    `sub → principal` directory (`setPendingOwner` / `resolvePrincipal`). Source-exported (`.`,
    `./provider`, `./oidc`).

  - **Meridian** consumes it. The worker picks the provider by config (`AUTH_PROVIDER=better-auth-do`
    default, or `oidc` + `OIDC_ISSUER`/`OIDC_AUDIENCE`); the app never learns which. `/internal/provision`
    seeds the owner seat, and the first login **claims** it (the installer becomes `hr-admin`) —
    provider-agnostically. The shared D1 `AUTH_DB` and its identity directory are gone; `wrangler
--dry-run` shows only the `SCOPE` + `AUTH` (IdentityDO) Durable Objects, so the worker still passes
    the sandbox contract and is pushable to the dispatch namespace.

  Verified on real workerd (Better Auth path): provision → sign-up → invoke claims the owner seat →
  `hr-admin` op succeeds → `/api/me` returns the claimed principal. OIDC verified with jose
  (mint+verify): valid → subject; no token / wrong issuer / expired → null. 21 Meridian node tests pass.

  Follow-ups (see `demos/meridian/DEPLOY.md`): fold the `hr/whoami` shape back into `/api/me` so the
  owner lands on the Admin surface; adopt the package in Callout; remove the now-dead `src/auth.ts` /
  `src/auth-schema.ts`.
