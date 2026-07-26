# Deploying Meridian to the hosted platform

Meridian is now a **sandbox-clean, control-plane-less vertical** (like Callout), so it can be
pushed into the platform's Workers-for-Platforms **dispatch namespace** and provisioned by the
shared control plane. Its only bindings are its own `SCOPE` Durable Object and `AUTH_DB`; the SPA
is bundled into the worker (no `ASSETS` binding). This is what makes it pass `assertSandboxContract`
(`packages/control-plane-api/src/deploy.ts`) — a `CONTROL_PLANE` binding or a service binding to a
platform worker would be refused.

Until these steps are run, the dashboard catalog correctly **hides** Meridian in connected mode
(`apps/dashboard/src/catalog.ts` → `meridian: { connected: false }`), so nobody is offered an
install that would 501.

## Prerequisites

- The control plane is already configured with the `substrat-verticals` dispatch namespace and
  holds the Cloudflare API token (`packages/control-plane-api` `createWfpUploader`) — verticals are
  uploaded through it, not with your own credential (D-34).
- `@substrat-run/cli` built (`pnpm --filter @substrat-run/cli build`), and you can `substrat login`
  to the control plane.

## Auth: no D1 to create

Identity/credentials/sessions now live in a per-tenant **`IdentityDO`** (Durable Object, via
`@substrat-run/vertical-auth`) — its own SQLite, isolated per tenant. There is **no shared `AUTH_DB`
D1** to create. Auth is a config choice (`AUTH_PROVIDER`): the default `better-auth-do` runs Better
Auth in that DO; set `AUTH_PROVIDER=oidc` + `OIDC_ISSUER` (`OIDC_AUDIENCE`) to verify a bearer token
against an OIDC issuer (Supabase / Auth0 / AuthHero / Keycloak) instead.

## Steps

1. **(nothing to set for the default provider.)** The `IdentityDO` generates its OWN session-signing
   secret per tenant, in its own storage — so there is **no `wrangler secret put`**, and it's
   automatically different per tenant (one worker secret would be shared across every tenant, which
   is exactly what we're avoiding). Only for the OIDC provider do you set config:

   ```sh
   # OIDC instead of Better Auth: set vars AUTH_PROVIDER=oidc, OIDC_ISSUER=…, OIDC_AUDIENCE=…
   ```

2. **Push** the vertical. This runs the `build` hook (`pnpm --dir app build && gen-assets`), bundles
   with `wrangler --dry-run`, and uploads to the control plane, landing a **PENDING** version. The
   platform injects `PLATFORM_SECRET` / `ROUTER_SECRET` on upload — you do **not** set them.

   ```sh
   substrat login
   cd demos/meridian && substrat push   # slug/name from package.json; version auto-bumps
   substrat versions meridian           # confirm the version landed (admission: pending)
   ```

   `substrat push` needs no flags from inside the vertical: `slug`/`name` come from the
   package.json `substrat` block and the version is the registry's latest, patch-bumped.
   Override any with `--slug` / `--name` / `--version` when you need to.

3. **Admit** the version (a human checkpoint — model B). A push is not a deploy: a Substrat
   operator admits the version in the console's Verticals view (or the staff control-plane API)
   after reviewing the declared bindings.

4. **Promote to prod.** `substrat promote` self-serves `dev`/`staging`; **prod is a staff decision**
   and is promoted from the operator console. Once a `prod` version exists, the control plane's
   `resolveVertical('meridian')` finds it and `provisionInstance('meridian')` succeeds.

5. **Flip the catalog flag.** In `apps/dashboard/src/catalog.ts`, set `meridian.connected = true`
   (or drop the flag), then redeploy the dashboard. The marketplace now offers Meridian and installs
   provision a real instance.

## Verify (already done on `wrangler dev`, real workerd)

Smoke-tested locally end to end: `GET /` serves the SPA; `/internal/provision` is fail-closed (403
without `PLATFORM_SECRET`, 201 with it) and sets up the scope CP-lessly via `provisionScopeLocal`,
seeding the owner seat; a real **sign-up → session cookie → `/api/invoke`** claims that seat (the
installer becomes `hr-admin`) and the `hr/*` op succeeds on DO SQLite; `/api/me` returns the claimed
principal. `wrangler deploy --dry-run` shows only the `SCOPE` + `AUTH` (IdentityDO) bindings — no D1,
no service binding, so it passes `assertSandboxContract`.

## Known follow-ups (not blockers for provisioning, but for full hosted UX)

- **App data contract — done.** `/api/me` returns the SPA shape (`{ key, display, role, country,
  employeeId }`) via `hr/whoami`, and owner **login-linking is done** — the first sign-in claims the
  owner seat (`hr-admin`), so a real signed-up owner lands on the Admin/setup surface. (Reconciled
  in from the data-contract change.)
- **Scrive reconcile.** The timer half is now solved: `definePlatformSweeperDO`
  (`@substrat-run/adapter-cloudflare`) is a self-re-arming Durable Object alarm that drives
  `runPlatformSweep` — and unlike a cron, a DO alarm *does* run in a dispatch user-worker. What
  still blocks the pushed worker is the directory: a CP-less vertical has no `listConnections`
  for the sweep to enumerate, so reconciliation remains a standalone-mode feature until
  connections are reachable from the vertical's runtime (or the platform runs the pass for
  dispatch verticals, like the snapshot-GC orchestration).
