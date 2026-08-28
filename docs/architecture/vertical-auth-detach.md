---
status: built
layer: plan
description: Pick your issuer at install. All four phases implemented.
---

# RFC: detachable vertical auth — pick your issuer at install

**Status:** **built** — all four phases implemented 2026-07-26 (§3). **Extends:** [scope-local-permissions.md](./scope-local-permissions.md)
Phase 3 (sandbox-clean verticals) and the first-run/TOFU model (PRs #214/#215). **Depends
on:** [dashboard-ui.md](../briefs/dashboard-ui.md) (New-app flow, the Env tab),
[marketplace-publish.md](./marketplace-publish.md) (registry-driven catalog), the K-31
platform→vertical surface (`packages/control-plane-api/src/vertical-client.ts`).

## 1. Problem

Every hosted vertical currently embeds its own identity stack: Better Auth running inside
the per-tenant `IdentityDO` (`packages/vertical-auth`). That was the right Phase-3 move —
sandbox-clean, no shared auth database — but it has hardened into three walls:

- **Users are per-app.** A team running Meridian and Manyfold has two disjoint user
  databases, two invite flows, no SSO. Nothing can share a login.
- **The auth choice is per-deployment, not per-install.** The `AuthProvider` seam already
  exists (`better-auth-do` | `oidc`, chosen by `AUTH_PROVIDER` env in
  `demos/meridian/src/worker.ts`), but under WfP dispatch one script serves *every*
  install — worker env cannot express "this instance uses Supabase, that one uses the
  team's auth server."
- **The OIDC path is verify-only.** `oidcAuthProvider` validates a presented bearer token;
  no browser login flow exists in any vertical SPA. "The SPA redirects to the issuer" is
  documented intent, not code.

Meanwhile `demos/auth-server` is a full Better Auth OIDC issuer (discovery, authorize,
token, JWKS, open dynamic client registration, admin SPA) — and it is an island: the
registry mistook it for a dispatch vertical and its install failed with a 500 (the
`/internal/provision` → SPA-fallback incident, 2026-07-25).

**Goal:** auth moves *out* of Meridian and Manyfold. At app creation (and later in
Settings) the installer picks the app's identity source:

1. an **Auth Server app in the same team** — one click, wired automatically; or
2. an **external OIDC issuer** — Supabase, Auth0, AuthHero, Keycloak, … by issuer URL.

## 2. Design

Three moves, each independently shippable.

### 2.1 auth-server becomes a real multi-instance vertical

Today: one fixed-name DO (`idFromName('auth-server')`), issuer identity from a
per-deployment `PUBLIC_ORIGIN` env. Converted:

- **DO per instance:** `idFromName(scopeId)` — each install is its own issuer with its own
  users, sessions, `auth_secret`, and JWKS (all already per-DO-storage; the fixed name was
  the only global).
- **K-31 surface:** implement `/internal/provision` (idempotent, records the instance and
  its canonical origin) and honest JSON 404s for unknown `/internal/*` paths *before* the
  SPA catch-all — the missing route must never again return 200 HTML to the platform.
- **Issuer origin from the platform, not env:** the OIDC `issuer` claim must equal the
  public origin, so the canonical hostname rides in on provision (and on the
  configure verb below when a hostname changes). `PUBLIC_ORIGIN` env remains only as the
  standalone/self-deploy override.
- **Catalog:** listed and installable like Meridian/Manyfold. The bootstrap-admin keys
  (`ADMIN_EMAIL`/`ADMIN_PASSWORD`) move from worker envSpec to per-instance config
  (§2.2) — or simply stay unused on the hosted path, where the existing setup screen +
  TOFU-style first-admin flow covers bootstrap.

The registry should still learn a `deployment: 'dispatch' | 'standalone'` kind for
genuinely standalone pushes (the GitHub-deploy path), but auth-server itself stops needing
the escape hatch.

### 2.2 Per-instance config, delivered through the platform seam

Sandbox-clean verticals have no control-plane binding, so config must be *pushed to* the
instance, not read from a shared store. The dashboard's Env tab already authors per-app
values (`dashboard/set-app-env`) and explicitly defers delivery — this is that missing
step, with auth as its first consumer:

- **`POST /internal/configure`** joins the K-31 verbs (platform-secret-authenticated,
  same trust line as provision): upserts `{ key, value }` config entries for one scope
  into the vertical's own storage. Idempotent; re-runnable by the reconciliation sweep.
- **`ProvisionInstanceInput` gains optional `config`** so a new app arrives configured
  atomically — no window where the instance is live but auth-less.
- Control-plane route + `TenantNarrowedControlPlane.configureInstance` +
  `VerticalClient.configure` plumb it through; the dashboard Env tab's PUT now also
  delivers (author → deliver in one action).

Auth config is a reserved, structured entry within that mechanism:

```jsonc
"substrat:auth": {
  "mode": "oidc",              // or "builtin" during the deprecation window
  "issuer": "https://auth-sesamy.global.substrat.run",
  "clientId": "…",
  "clientSecret": "…",         // secret-flagged: write-only in the dashboard
  "audience": "…"              // optional
}
```

**The read side (`resolveScopedEnvSpec`).** Delivery only lands the value in the scope's own
storage; the vertical still has to READ it there and overlay it on its manifest env-spec at
request time. `resolveScopedEnvSpec(spec, env, delivered)` (contracts) is that merge —
precedence **delivered > env > default**, declared keys only — where `delivered` is the
per-scope config the vertical read back from its own store (auth-server's `cfg:` rows,
vertical-auth's `scope_config` table). Reading `resolveEnvSpec(env)` alone is the trap: the
env-spec defaults ride as worker bindings shared by every install of one serving script, so a
per-install override saved in the Env tab is invisible to it and the instance silently serves
the default (the #374 incident). A hosted vertical reads per-scope; only a standalone deploy
reads env. For a vertical on `@substrat-run/vertical-auth`, the `delivered` map comes from
`IdentityDO.getScopeConfig(scopeId)` (or from `authWiring()`'s `config`, already in hand on
the auth path — Meridian resolves its ordinary keys from that same hop, no extra round-trip).

### 2.3 Verticals become pure OIDC relying parties

- **Login flow:** generalize `@substrat-run/oidc-rp` (Authorization Code + PKCE, cookie
  sessions — already proven in the dashboard and console) to take its
  issuer/client/secrets from a config object per request instead of worker env. Meridian
  and Manyfold mount it when the instance's auth mode is `oidc`: `/api/auth/login` →
  issuer `/authorize` → `/callback` verifies the ID token → session cookie. The session
  cookie is signed with a per-instance secret minted in the vertical's own DO (the same
  pattern `IdentityDO`/`AuthServerDO` use for their secrets).
- **The SPA sign-in screen** becomes a "Continue with sign-in" redirect button in OIDC
  mode; the email/password forms remain only for `builtin` mode during deprecation.
- **`oidcAuthProvider` (bearer verification) stays** as the API-client path — same
  issuer, token presented directly.
- **The identity directory stays put.** `IdentityDO` minus Better Auth is still needed:
  `sub → principal` mapping, the pending-owner claim on first login (bounded to a window
  after provision since #925; a dashboard-minted claim link binds the owner after that), and
  invites.
  Those are authorization concerns of the *vertical*, whoever authenticates. An invite
  stops creating credentials: the invitee authenticates at the issuer (self-serve if the
  issuer allows, or created by an auth-server admin), opens the invite link, and the
  claim binds their `sub` to the pre-minted principal — the sign-up-gate route disappears
  in OIDC mode.

### 2.4 The install flow

The New-app form gains an **Identity** section:

- **"Auth Server in this team"** — a dropdown of the team's active apps with
  `vertical_slug === 'auth-server'`; empty state links to installing one first.
- **"External OIDC issuer"** — issuer URL, client id/secret (or bearer-only for
  API-style apps).

For the auth-server option the dashboard does the wiring itself, in this order (hostname
must exist before the redirect URI can):

1. provision scope + instance + bind hostname (today's sequence, unchanged);
2. **register an OAuth client** at the chosen issuer via its dynamic-registration
   endpoint (already enabled in `demos/auth-server/src/auth.ts`), redirect URI
   `https://<app-hostname>/api/auth/callback`;
3. deliver `substrat:auth` via `/internal/configure`.

A failure in 2–3 marks the app `failed` with the real reason (the provisioning audit
trail from `mark-app-failed` already handles this).

Settings shows the current mode/issuer and allows re-configuring. **Caveat to decide
(§4):** principal bindings are keyed by the issuer's `sub`, so *switching* issuers on a
live instance orphans every mapping — members would re-claim via fresh invites.

## 3. Phases *(all four implemented, 2026-07-26)*

1. **auth-server conversion** ✅ — per-scope DO, `/internal/provision`, JSON 404s,
   request-origin-derived issuer. Fixes the standing install failure.
2. **Config delivery seam** ✅ — `/internal/configure` (+ `tenantId` on the wire, for
   tenant-sharded harness stores) + provision-time `config` + Env-tab delivery with a
   `delivered` flag. Generic; unblocks any per-instance setting, not just auth.
3. **RP flow in verticals** ✅ — `oidcRpAuthProvider` in vertical-auth (oidc-rp needed
   no refactor — its env is already a parameter; jose 5→6 so node JWKS fetching matches
   workerd), per-tenant DO-minted session secret, Meridian per-scope provider selection
   + login screen + invites-over-OIDC. **Manyfold parity still pending.**
4. **Install UI + auto client registration** ✅ — the New-app Identity section
   (builtin / team Auth Server / external OIDC), RFC 7591 dynamic registration at the
   chosen Auth Server (`token_endpoint_auth_method: client_secret_post`, discovery-driven
   endpoint), delivery after hostname bind, loud failure onto the app's audit trail.

## 4. Decisions — how they landed

- **D1 — default for a new app: `builtin`, explicit opt-in to an issuer.** The registry
  does not yet declare which verticals SUPPORT `substrat:auth`, so defaulting to an
  issuer would break installs of verticals that ignore it (Callout). Upgrading the
  default to "the team's auth server when exactly one exists" waits on a capability
  flag on the registry row.
- **D2 — session mechanism: server-side RP with cookie sessions** (oidc-rp reused;
  bearer verification retained for API clients).
- **D3 — switching issuers: create-time only, for now.** The Env tab can't author
  `substrat:auth` (UPPER_SNAKE keys only), and re-pointing a live instance orphans its
  `sub → principal` bindings. A Settings surface with explicit re-invite semantics is
  future work. Note: **retry of a failed app loses the auth choice** (a retry provisions
  a fresh scope) — re-create with the choice instead.
- **D4 — existing installs: stay on `builtin`** until their owner opts in; no guided
  user-export migration yet.

Platform apps (dashboard, console) are out of scope — they stay on AuthHero per the
auth-consolidation decision; this RFC is about *tenant* apps only.
