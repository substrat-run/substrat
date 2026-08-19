# Deploying Manyfold to the hosted platform

Manyfold is a **sandbox-clean, control-plane-less vertical** (the policy: every vertical is
sandbox-clean, only the dashboard is privileged). Its only bindings are its own `SCOPE` Durable
Object and the `AUTH` `IdentityDO`; the SPA is inlined into the worker (no `ASSETS` binding). That
is what makes it pass `assertSandboxContract` (`packages/control-plane-api/src/deploy.ts`) — a
`CONTROL_PLANE` binding or a service binding to a platform worker would be refused. So it can be
pushed into the platform's Workers-for-Platforms **dispatch namespace** and provisioned by the
shared control plane.

This file is also the write-up of the concepts a real deploy session got stuck on (#385). The
generic model lives in the docs site (`apps/docs/guide/deploying.md`,
`apps/docs/concepts/deploying.md`); what follows is the Manyfold-specific state plus the traps.

## Two lineages — read this first

Manyfold currently exists as **two registry lineages**, and which one you touch is decided by
your *credential*, not by the directory you push from:

1. **The platform-owned builtin** — bare slug `manyfold`, registered by
   `apps/dashboard/src/catalog.ts` (`source: 'builtin'`), **listed** on the marketplace. This is
   what marketplace installs resolve today.
2. **The tenant-owned lineage** — `substrat-9yjbbn/manyfold`, pushed through the builder plane.
   This is the intended, builder-plane-native model; #389 tracks retiring the builtin (including
   an update-rebind path for installs pinned to it).

The control plane forms the registry id from the authenticated principal: a **builder**
credential (a browser `substrat login` session or a tenant-scoped push token) gets its workspace
slug prepended — `substrat push` lands on `substrat-9yjbbn/manyfold`. A **staff service token**
addresses the bare slug — the same push lands on the platform lineage. Push with the wrong
credential and you silently get "two manyfolds" that never update each other.

The `"substrat": { "tenant": "substrat-9yjbbn" }` pin in `package.json` is load-bearing: it pins
which workspace a push acts for, independent of whatever login default the machine holds. Keep it.

## Credentials — one env var, three tokens

Everything rides the same `SUBSTRAT_SERVICE_TOKEN` env var / `x-service-token` header,
discriminated by prefix (`packages/control-plane-api/src/push-token.ts`):

- **Browser session** (`substrat login`) — humans on laptops. Short-lived, per-person.
- **Tenant-scoped push token** (`spt1.…`) — the CI credential. A long-lived machine credential
  that authenticates as a *builder principal for exactly one tenant*: it reaches only the
  builder-allowlisted routes and only that tenant's `<tenant>/…` namespace. It can never admit a
  version, never prod-promote a **listed** vertical, never touch another tenant. This is what
  belongs in a customer repo.
- **Platform `SERVICE_TOKEN`** — staff-equivalent. It **must never land in a customer repo**: it
  addresses bare slugs (the wrong lineage, see above) and carries platform-wide authority.

Auth resolves in this order: explicit `--token` / `SUBSTRAT_SERVICE_TOKEN` → stored browser
session → stored service token. Two gotchas the CLI now warns about, learned the hard way:

- **A stray exported `SUBSTRAT_SERVICE_TOKEN` shadows a fresh `substrat login`** — the session is
  silently ignored (#387; the CLI prints a warning since then, but the env var still wins).
- **`SUBSTRAT_CP_URL` must be the `/api` base** — `https://console.substrat.net/api`, not the
  console page. An HTML response where JSON was expected is the tell (the CLI's error names this).

## One-click CI — "Set up deployment"

The shipping path for git → platform is CI in *your* repo (the platform never builds arbitrary
repo code server-side — that is the model-A gap in `docs/architecture/self-serve-deploy.md`). The
dashboard's git-import view (Deployments → connect the GitHub App → pick repo + branch → **Set up
deployment**) does three things, in a deliberate order:

1. Mints a **tenant-scoped push token**.
2. Writes it as the repo's `SUBSTRAT_SERVICE_TOKEN` Actions secret (secret **before** workflow —
   committing the workflow triggers the first run immediately, and that run must find its
   credential).
3. Commits `.github/workflows/substrat-deploy.yml` to the chosen branch.

The generated workflow: on push to the branch, install dependencies (the install step is
load-bearing — `substrat push` runs the repo's *own* wrangler build, so devDependencies must be
on disk; corepack picks the package manager from the lockfile) and `substrat push --promote prod`;
on PR open/update, create/update a **preview** (the PR's code against a fork of prod, URL
commented on the PR); on PR close, reap it.

Two operational traps from the deploy session:

- **A vertical registers only on its first *successful* push.** A failed CI build is invisible in
  the dashboard — there is no vertical row to hang an error off yet. Check the repo's Actions tab.
- Older GitHub App installations may lack the widened permissions (contents, workflows, secrets);
  the UI then offers re-approval or the manual copy-paste path.

## A push is not a deploy

A push uploads a **version**; a **promotion** points a channel at it and makes scopes serve it.
Who closes that gap depends on the vertical's audience (decision D-36):

- **Private** (owned, not listed) — the sandbox contract is the whole gate: a push lands
  **admitted** automatically and every channel, prod included, is self-serve. The generated
  workflow's `--promote prod` makes merge-to-main the deploy. This is `substrat-9yjbbn/manyfold`
  today.
- **Listed** (on the marketplace, other tenants run the code against their data) — pushes land
  **pending**, admission is a staff decision, and prod promotion is staff-gated too. You cannot
  fully automate git → prod-for-all-tenants, *by design*; the workflow's `--promote prod` step
  fails loudly naming the gate. This is what the builtin `manyfold` is, and what the tenant-owned
  lineage becomes once `substrat publish`ed and staff-listed (#389).

## Multi-scope note (the one difference from a single-scope vertical)

A Manyfold **install = one tenant with many SITES**, each its own scope/`ScopeDO`
(`idFromName(tenant, site)`). So the platform calls **`/internal/provision` once per site**
(owner granted `admin` at each). The router asserts the tenant + home site; the app selects the
active site via `x-scope`, and permissions evaluate from that site's own DO storage. Adding a
site later is another `/internal/provision` call — no redeploy.

## Auth inside the app: no D1 to create

Identity/credentials/sessions live in the per-tenant **`IdentityDO`** (its own SQLite, isolated
per tenant); it generates its own signing secret in its own storage — nothing to `wrangler secret
put`. Auth is a config choice (`AUTH_PROVIDER`): default `better-auth-do` runs Better Auth in
that DO; set `AUTH_PROVIDER=oidc` + `OIDC_ISSUER` (`OIDC_AUDIENCE`) to verify bearer tokens
against an OIDC issuer instead. Sign-up is closed after first-run setup; admins add people via
per-site invites (Members view). The platform injects `PLATFORM_SECRET` / `ROUTER_SECRET` on
upload — you do not set them.

## Known follow-ups

- **Retire the builtin lineage** (#389): `substrat publish` + staff-list `substrat-9yjbbn/manyfold`,
  drop the `catalog.ts` entries, and rebind existing installs pinned to the builtin version.
- **R2 asset connector** for `assetRef` uploads (the media library remains a designed shell
  until then).
