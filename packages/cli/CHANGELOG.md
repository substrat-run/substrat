# @substrat-run/cli

## 0.5.3

### Patch Changes

- Updated dependencies [b4a6bee]
  - @substrat-run/contracts@0.19.0

## 0.5.2

### Patch Changes

- d18a247: `HostAdmin.setTenantName` + `PATCH /tenants/:tenantId` — a display-only rename (the
  slug, which registry ids key on, never moves). The dashboard's identity mirror uses
  it to keep the shared directory's tenant names in step with team names, so the CLI's
  workspace picker shows the organization, not a placeholder; the CLI now lists
  workspaces name-first.
- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0

## 0.5.1

### Patch Changes

- @substrat-run/contracts@0.17.0

## 0.5.0

### Minor Changes

- 0caa0a9: Account switching actually works: force past the IdP SSO cookie and the browser session.

  Before this, "sign in as a different account" was impossible: `/api/auth/logout` only
  cleared the app's own `sb_session` cookie, the IdP's SSO cookie survived, and the next
  authorize round-trip silently re-authenticated the old user — no typed email could win.
  The CLI broker added a second layer: `substrat login` reused any live browser session
  without ever showing a login screen.

  **oidc-rp**: `/api/auth/login` now passes through an allowlisted `prompt`
  (`login` | `select_account`) so the IdP re-prompts past its SSO session, and
  `/api/auth/logout?federated` chains through the issuer's `end_session_endpoint`
  (RP-initiated logout, discovery-driven; local-only remains the default so other apps
  on the shared IdP session keep theirs).

  **control-plane**: the CLI login broker accepts `fresh=1` — it skips the live browser
  session and bounces through `/api/auth/login?prompt=login`, stripping `fresh` from the
  returnTo so the post-login bounce uses the new session instead of looping.

  **cli**: `substrat login --fresh` requests exactly that flow, and
  `substrat workspaces` lists your workspaces (an alias of `whoami`).

### Patch Changes

- 81e9408: The deploy manifest becomes a shared contract (#190 part A): `deployManifest` and
  `DeclaredBinding` move from `control-plane-api` into `@substrat-run/contracts`, and
  BOTH ends of the push seam now speak the same schema — the CLI parses the manifest it
  builds with `deployManifest.parse(...)` before uploading, the control plane re-parses
  it at the trust boundary and runs the §4 sandbox contract against the result.

  Before this, `push.ts` hand-rolled a parallel manifest object against a local
  `DeclaredBinding` interface while the server parsed the real Zod schema — a drift
  hazard on the deploy trust boundary, where a shape mismatch surfaced only as a 4xx
  from the deploy endpoint. Now drift is a compile error (shared types) or a local parse
  failure before any bytes are uploaded; a CLI-side effect is that registry metadata
  (`envSpec`, `ownerGrants`, `provides`, `requires`) is validated at push time too.

  `control-plane-api` re-exports the schema and types unchanged, so hosts keep importing
  from the transport package. The CLI gains its first runtime dependency
  (`@substrat-run/contracts`) — deliberate: the alternative was the drift. Part B of
  #190 (a substrate-neutral `runtimeNeeds` manifest section) stays open, gated on the
  product decision the issue describes.

- Updated dependencies [b23c0a7]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0

## 0.4.0

### Minor Changes

- f9db289: `substrat push` resolves its workspace from the project, never the machine: `--tenant` →
  `SUBSTRAT_TENANT` → a `"substrat": { "tenant" }` pin in the vertical's `package.json`. The
  machine-wide login default is deliberately out of the chain — the first push of a slug
  **claims** `<workspace>/<slug>` for whatever workspace resolved (builder-plane.md §5), so a
  stale global default silently pointing at the wrong workspace would claim the vertical for
  the wrong owner.

  A first interactive push with no pin lists your workspaces (whoami), auto-selects a sole
  one, and offers to write the pin into `package.json` — repo-scoped, reviewable, shared with
  every teammate and CI — so the question is answered once per project, not once per push. A
  non-TTY push with no pin refuses with an actionable error instead of guessing. The push
  line now prints the full target (`pushing acme-co/crm@0.1.0 …`) so the claiming workspace
  is always visible; service-token pushes are unchanged (the platform actor has no
  workspace). `promote`/`scope pull` keep the login-default fallback — ownership is already
  checked server-side there.

  `resolveAuth` gains `useDefaultTenant: false` and a `kind: 'session' | 'service'` field;
  `readVerticalMeta` reads the new `substrat.tenant`; new `pinTenant(dir, tenant)` writes it
  back preserving the file's indentation. Docs: CLI reference gets the full command surface
  (`whoami`, `versions`, `publish`/`unpublish`, flagless `push` defaults table, first-push
  transcript) and the deploying guide explains the per-project pin.

## 0.3.1

### Patch Changes

- cb6131c: docs: point every published package's `homepage` at its substrat.net page and
  swap the stale `substrat.ahlstrand.es` doc links in READMEs for `substrat.net`.
  Add the three missing READMEs (`engine-booking`, `cli`, `control-plane-api`).
  Metadata/docs only — no code or API change; a republish is needed for the
  updated README + homepage to render on npm.

## 0.3.0

### Minor Changes

- 1cbc2be: `substrat push` carries a vertical's declared env-spec to the registry. The CLI reads
  `substrat.envSpec` from the vertical's `package.json` — the same static, code-free source it
  already reads `slug`/`name` from — and includes it in the deploy manifest, so a pushed vertical
  gets a Dashboard config form exactly like a builtin.
- 1022c15: **Registry-driven marketplace, phase 3b** (marketplace-publish.md §5) — request-to-publish in
  place, so a builder can drive the whole loop.

  - `HostAdmin.requestPublish(actor, slug)` — an owner records a pending publish request; sets the
    registry `publish_requested_at` on the vertical (both adapters), audited (`requestPublish` admin
    action). `setVerticalListed` now **clears** the request when staff reviews and lists it, so the
    pending queue drains itself.
  - Control-plane endpoint `POST /verticals/:slug/publish-request` — **owner-checked** and on the
    builder allowlist, so an owner asks with a bare slug; staff listing stays the gate.
  - CLI `substrat publish <slug>` now _requests_ listing ("✓ publish requested … an operator will
    review it") instead of flipping it; `substrat unpublish` is the staff unlist.

  The full loop — builder requests → `publishRequestedAt` set → staff lists → `listed` true + request
  cleared — is covered end-to-end (contract-suite across both adapters + a control-plane API test).
  The dashboard "Request to publish" button + a console pending-requests list are the remaining UX.

- 1022c15: **Registry-driven marketplace, phase 1** (marketplace-publish.md) — carry a vertical's
  install metadata to the registry on push, so a later phase can drop the dashboard's hardcoded
  `CATALOG` map.

  - `moduleManifest` gains additive fields: `ownerGrants: permissionKey[]` (the day-one owner
    grant — the role _table_ stays vertical-owned + runtime-customizable), `entitlements`, and
    `provides` / `requires` **capability** lists (`oidc-issuer` etc., wired tenant-side through
    the connection store — no `kind` flag, no bundling). New `capability` contract type.
  - The registry `vertical` + `registerVerticalInput` carry all four; stored as one
    `install_spec` JSON column in both adapters (sqlite + cloudflare), via the existing
    `ensureColumn`/`addColumn` helper, alongside `env_spec`.
  - `substrat push` reads them from `package.json` `substrat.*` and the control-plane deploy
    endpoint validates + stores them on `registerVertical` — exactly the rail `envSpec` rides.

  No behaviour change yet: the dashboard still gates on `CATALOG`. Phase 2 makes
  `availableCatalog`/`createApp` registry-driven.

- 1022c15: **Registry-driven marketplace, phase 3** (marketplace-publish.md §5) — the publish action.

  - `HostAdmin.setVerticalListed(actor, slug, listed)` — a staff admission that flips the registry
    `listed` flag (both adapters); idempotent, audited (`setVerticalListed` admin action). Once
    `listed`, `availableCatalog` offers the vertical to every tenant.
  - Control-plane endpoint `POST /verticals/:slug/listing` — **staff-only** (not on the builder
    allowlist), so a builder is refused (the review gate), staff flips it. Mirrors admission (model B).
  - CLI `substrat publish <slug>` / `substrat unpublish <slug>`.

  The `listed` column is set on insert and by this action only — **never clobbered by a re-push**
  (covered by a contract-suite test across both adapters). Any owner may _request_ publishing;
  staff review is the gate (§5). The builder self-serve request surface (a dashboard "Request to
  publish" button) is the remaining UX — the same open question as builder-plane's prod-promotion
  request.

## 0.2.0

### Minor Changes

- 32abe73: **`substrat push` needs no flags.** Run it from inside the vertical and it defaults everything:

  - **dir** → `.` (the current directory).
  - **`--slug` / `--name`** → from a `"substrat": { "slug", "name" }` block in the vertical's
    `package.json`, or derived from the package name (`@substrat-run/demo-meridian` → `meridian`
    / `Meridian`).
  - **`--version`** → the registry's latest for that slug, **patch-bumped** — no more hand-tracking
    the number (falls back to the package.json version for a slug's first-ever push).

  So `cd demos/meridian && substrat push` replaces
  `substrat push demos/meridian --slug meridian --version 0.0.13 --name Meridian`. Every flag still
  works as an override. Adds `substrat` blocks to the Meridian + Callout demo package.json.

## 0.1.0

### Minor Changes

- 1dff2bd: **Builder writes — self-serve deploy, end to end (builder-plane.md Phase 3).** A tenant user
  can now `substrat login`, `push`, and `promote` their own verticals without staff, and the
  control plane forms the `<tenantSlug>/<name>` id they never type. This makes the Phase-2
  authz mechanism live.

  - **Prefixed vertical ids (`verticalSlug`)** — a new contracts brand allows an optional single
    `<tenantSlug>/` prefix; the registry schemas use it. A builder pushes a **bare** `--slug`;
    the control plane prepends their authenticated tenant's slug, so two tenants can each own a
    `helpdesk` with **no global claim race** (Vercel-style non-scarce namespace). Platform
    verticals stay bare. `deploymentRefFor` already flattens the `/`; hostnames never carry it.
  - **The live builder reader** (`oidcBuilderReader`, control-plane worker) — the same signed
    session the CLI/console carries resolves via the shared identity directory to the tenants a
    user belongs to, narrowed to the selected one → a `(actor, tenantId, tenantSlug)` builder
    principal. **No vetting roster**: self-serve is the point; a user with no workspace is
    declined (sign up in the dashboard first). The audited actor is a stable
    `PlatformActorId` derived from the OIDC subject.
  - **`effectiveSlug`** threads the prefix through every builder vertical route
    (`control-plane-api`), so ownership, filtering and dispatch all key on the real id.
  - **`GET /api/auth/whoami`** — the session's user + the tenants it can build for. The CLI
    calls it on `login` to store a default workspace (prompting when there are several).
  - **CLI** — `substrat whoami`; `substrat promote <slug> --channel dev|staging --version <id>`
    (a builder self-serves non-prod; prod + admission stay staff, model B); `--tenant` /
    `SUBSTRAT_TENANT` / a stored default, sent as `x-substrat-tenant` with a browser session.

  Scope: no auto-bootstrap of a workspace from the CLI (a builder signs up once in the
  dashboard, then the CLI just works) — flagged as a follow-up.

  Verified: control-plane-api (71) incl. the reworked builder matrix under prefixing (each
  tenant gets its own namespace, no collision), control-plane worker (17) incl. a live
  end-to-end builder path (bare push → `acme-co/helpdesk`, whoami, fail-closed no-workspace),
  adapter suites (147 + 153) and `pnpm -r typecheck` all pass.

- cc5f2ca: **`substrat login` — a real browser login for the CLI (loopback OAuth, no AuthHero change).**

  `substrat login` now pops the browser and authenticates you as yourself — the `wrangler login` / `gh auth login` experience — instead of pasting a shared token. The CLI never touches AuthHero: it logs in **through the control plane**, which already brokers AuthHero for the console, and gets back the same signed session it issues to a browser.

  - **The flow (PKCE, CLI ↔ control plane):** the CLI starts a localhost server, opens `…/api/auth/cli?port&state&challenge`; the broker signs the user in (bouncing through the existing `/api/auth/login` if there's no session yet, via a new same-origin `returnTo`) and redirects to `127.0.0.1:PORT/callback?code`; the CLI exchanges `code + verifier` for the session token. The token never transits a URL — only the PKCE-bound `code` does — and the exchange fails without the matching verifier.
  - **`@substrat-run/oidc-rp`**: exports `mintSession` (refactored out of `completeLogin`), `signEphemeral`/`verifyEphemeral`, `pkceS256`, and `safePath`; `mountOidcRoutes` honours a validated same-origin `returnTo`.
  - **`apps/control-plane`**: `oidcStaffBearerReader` accepts the session as `Authorization: Bearer` (the same `verifySession`, the **same staff roster** gate as the cookie); `cli-auth.ts` mounts the broker routes. Pushes are attributed to the **human**, not a shared actor. **No AuthHero client or redirect URI is added** — AuthHero still only ever redirects to the console.
  - **`@substrat-run/cli`**: the loopback `login` flow (default); `login --token` / `SUBSTRAT_SERVICE_TOKEN` still stores a service credential for CI. `push` sends whichever the config resolves — a bearer session (per-human) or `x-service-token` (service actor).

  Verified: oidc-rp, control-plane, dashboard and cli typecheck; a new workerd test drives the whole broker end-to-end — the PKCE round-trip issues a bearer the deploy surface accepts, a wrong verifier is refused (400), and a valid session for a non-rostered user is refused (401, fail closed).

- 9d3c4a3: **`@substrat-run/cli` is now public — published to npm under Apache-2.0.** The deploy CLI holds
  no platform IP (it builds your vertical locally and POSTs a bundle; the control plane holds the
  Cloudflare credential), so it ships permissively — the industry norm for a deploy CLI — while
  the rest of the platform stays AGPL + commercial.

  - `private: true` removed; `publishConfig.access: public`, `repository`, `homepage`, `keywords`,
    and `engines` (`node >= 20`) added; license changed from AGPL-3.0-or-later to **Apache-2.0**
    (with a per-package `LICENSE`, shipped in the tarball).
  - Install: `npm install -g @substrat-run/cli`.

  Docs: the [Deploying a vertical](https://substrat.net/guide/deploying) guide is rewritten for
  the builder plane (the `<workspace>/<slug>` prefix, `whoami`, `--tenant`, `promote`, the
  dashboard Deployments view), a new `@substrat-run/cli` reference page is added, and the
  dashboard platform page documents the Deployments tab.

- ed99919: **`substrat versions <slug>`** — list a vertical's versions and which channels point at
  them, from the CLI. The first slice of _builder self-service visibility_: seeing the
  verticals you pushed without the staff console.

  It reads the existing registry endpoints (`/verticals/:slug/versions`, `/channels`), so
  it works for staff today and — once builder-scoped authz + slug ownership land — for
  builders viewing their own verticals. Read-only; admission and prod promotion stay the
  staff trust gate (self-serve-deploy.md model B).

- 7070588: **Push forwards `compatibility_flags`, and the deploy endpoint surfaces upload failures.**

  A pushed vertical that needs a compat flag — `nodejs_compat` for Better Auth / any `node:*` import — was being uploaded **without** it: the CLI manifest, the deploy schema, and the WfP metadata all carried only `compatibility_date`. So the script couldn't start, Cloudflare rejected the upload, and `deployVertical` threw — which the generic handler flattened into an anonymous `500 {"error":"internal error"}`, undiagnosable without worker logs. Callout hit exactly this.

  - **`compatibility_flags` now travels end to end**: `substrat push` reads it from `wrangler.jsonc` into the manifest (`deployManifest`/`VerticalBundle` gain `compatibilityFlags`), and `createWfpUploader` emits it in the script metadata.
  - **The deploy endpoint wraps `deployVertical`** and returns **`502 { error, detail }`** with the runtime's actual message (the builder is authenticated — this is platform/runtime error detail, not a bad request), plus a `console.error`, instead of a blank 500.

  Verified: control-plane-api suites pass, including new tests that `nodejs_compat` survives to the uploader and that an upload failure surfaces as a 502 with detail.

- fbd2627: **A real `substrat` CLI — authenticated vertical deploys (replaces `tools/substrat-push.mjs`).**

  The push capability is now a proper package (`@substrat-run/cli`, `bin: substrat`) with a stored credential, instead of a bare script that only worked against a dev control plane.

  - **`substrat login`** stores the control-plane URL + `SERVICE_TOKEN` in `~/.substrat/config.json` (chmod 600, token prompt hidden). **`substrat push <dir> --slug --version`** builds the vertical (`wrangler --dry-run`, running its own `build.command`), assembles the manifest (DO + D1 bindings), and uploads. Auth resolves flag → env (`SUBSTRAT_CP_URL` / `SUBSTRAT_SERVICE_TOKEN`) → config.
  - **Authenticates as the platform service actor via `x-service-token`** (`serviceTokenAuth`), not the dev-only `x-platform-actor` header the old script sent. That header is trusted only under `ALLOW_DEV_ACTOR=true`, so the old script could not push to a production control plane at all; this can. No `--actor` is chosen — the service token _is_ the identity. No control-plane change: `serviceTokenAuth` was already wired.
  - Removed `tools/substrat-push.mjs`; `pnpm substrat …` (root script) and `demos/callout/wrangler.example.jsonc` point at the CLI. Push stays PENDING — admission in the console still gates serving.

  Run: `pnpm -r build` then `pnpm substrat login` → `pnpm substrat push demos/callout --slug callout --version 0.1.0`.
