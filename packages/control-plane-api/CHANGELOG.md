# @substrat-run/control-plane-api

## 0.18.0

### Minor Changes

- d18a247: `HostAdmin.setTenantName` + `PATCH /tenants/:tenantId` — a display-only rename (the
  slug, which registry ids key on, never moves). The dashboard's identity mirror uses
  it to keep the shared directory's tenant names in step with team names, so the CLI's
  workspace picker shows the organization, not a placeholder; the CLI now lists
  workspaces name-first.

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0

## 0.17.0

### Minor Changes

- 983c06d: Identity-mirror routes (`PUT`/`DELETE /tenants/:tenantId/identities`): the seam the
  Dashboard writes builder identity links through, so the shared plane's whoami/builder
  auth can resolve a CLI session to its workspaces. Service/staff only — not in the
  builder allowlist.

### Patch Changes

- @substrat-run/contracts@0.17.0
- @substrat-run/kernel@0.17.0

## 0.16.0

### Minor Changes

- b23c0a7: The Data tab grows a SQL console (#219): `HostAdmin.queryScope` runs ONE read-only SQL
  statement against a scope's own database, next to the table-shaped reads that stay safe
  by construction. User SQL reaching the DB moves the safety to statement-level
  enforcement, in two layers shared across adapters:

  - the kernel's `assertReadOnlyQuery` — a comment/string/identifier-aware token scan
    that rejects multi-statement input, a first keyword outside SELECT/WITH/VALUES/
    EXPLAIN, and any bare write/DDL/session verb anywhere (`WITH … INSERT INTO` is valid
    SQLite, so the first keyword alone proves nothing); deliberately over-strict, since a
    false positive costs a quoted identifier and a false negative forges the spine;
  - an adapter-authoritative backstop: better-sqlite3's `prepare().readonly`
    (sqlite3_stmt_readonly) on the pure adapter, and a transaction that ALWAYS rolls
    back inside the ScopeDO, whose `exec` has no read-only flag.

  Results are positional rows capped at `SCOPE_QUERY_ROW_MAX` (200) with a `truncated`
  flag — a ceiling, never an error. Same K-3 (tenantId, scopeId) cross-check and K-24
  access log as the table reads; the logged argument is the SQL itself. The refusal
  message prefix (`read-only console:`) is contract — pinned by the shared suite against
  both adapters and mapped to 400 by the transport.

  Transport: `POST /tenants/:tenantId/scopes/:scopeId/query` with the same
  vertical-delegation as the table reads (`VerticalClient.queryScope` →
  `/internal/query`); a vertical that cannot answer safely refuses with its own status,
  relayed verbatim — auth-server keeps refusing via its `/internal/*` 501 catch-all,
  because its DO redacts secret-bearing columns on table reads and arbitrary SQL would
  walk around the redaction. Editing rows stays out of scope forever: a write here would
  bypass the event log and forge the spine.

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
  - @substrat-run/kernel@0.16.0

## 0.15.0

### Minor Changes

- 297e057: Observability, views 1–3 of design/observability.md — piggyback Cloudflare, stamp
  what only we know:

  - **Seam + Cloudflare reader** (`control-plane-api`): a provider-neutral
    `ObservabilityReader` contract (service/namespace vocabulary, never
    script/dispatch-namespace) with `createCfObservabilityReader` as the injected
    Cloudflare implementation (GraphQL invocation analytics + the Workers
    Observability telemetry query API) — the `DeployVerticalFn`/`wfp.ts` pattern, so
    an APM/OTel backend can slot in behind identical routes later. Two staff-only
    proxy routes: `GET /observability/metrics` and `GET /observability/logs`
    (501 when no backend is configured; deliberately not in `BUILDER_ROUTES`).
  - **Router**: one Analytics Engine datapoint per resolved request — index
    `tenantId`, blobs `(vertical, scope, surface, statusClass, rayId)`, doubles
    `(durationMs, status)` — plus a structured JSON log line with the same fields.
    The router is the only place that knows which tenant a request belonged to;
    written now so tenant-keyed history accrues before any tenant-facing read path
    exists. Metering never fails a request, and error paths are counted.
  - **WfP uploads**: pushed verticals get `observability: { enabled: true }`, so
    builder logs exist to query.
  - **Console**: an Observability fleet view — per-service invocations, error
    rates, CPU quantiles, and a row-click recent-logs panel.
  - **Dashboard**: a Traffic panel on the Verticals view showing the team's own
    deployed versions (requests/errors/CPU + recent logs). Owner-narrowing lives in
    `TenantNarrowedControlPlane`: metrics rows are filtered to owned deployment
    refs and mapped back to (vertical, version); a logs query for an unowned ref
    answers `[]` without ever reaching the plane.

  Deploy notes: the control plane's `CF_API_TOKEN` additionally needs **Account
  Analytics: Read** and **Workers Observability: Read**; the router redeploy picks
  up the `substrat_router` AE dataset binding (auto-created on first write).

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

- ec89a88: Vertical lifecycle: delete a vertical, and block new installs of one.

  **`deleteVertical`** (HostAdmin + `DELETE /verticals/:slug`, staff-only): removes the
  registry row, its versions, and its channels — **refused while any scope is still
  bound** to the vertical, naming the count, so a delete can never strand a live scope's
  version pin or routing. Deployed dispatch scripts are left as orphans for the cleanup
  script (#248), never reaped inline. Audited. The console's vertical detail card gets a
  type-the-slug-to-confirm Delete.

  **`installsBlocked`** (new registry flag + `setVerticalInstallsBlocked` /
  `POST /verticals/:slug/install-block`, staff-only): the install kill-switch, orthogonal
  to `listed`. A blocked vertical is hidden from the dashboard's install catalog and the
  control plane refuses to provision an instance of it (403) — for everyone, owner
  included. Existing scopes keep serving: it gates provisioning, not serving. Additive
  `installs_blocked` column in both adapters (attempt-and-tolerate migration, default 0).
  Console gets a Block/Allow installs toggle and a "blocked" badge.

  The console also now shows **timestamps**: when each version was pushed (table +
  promote picker), when each channel pointer last moved, and when a vertical was
  registered.

### Patch Changes

- 7ed3015: The dashboard Data tab works for Auth Server apps ("Couldn't load the database — internal error").

  **auth-server** now implements the §5.4 introspection verbs (`GET /internal/tables`,
  `GET /internal/tables/:table`): the issuer DO's Better Auth SQLite is a real per-scope
  database, and it answers the same two table-shaped, platform-gated reads a ScopeDO does.
  Secret-bearing columns are redacted inside the DO before anything crosses its boundary —
  password hashes, session tokens, OAuth tokens/client secrets, JWKS private keys, and the
  issuer's own signing secret (`config.value`, which also carries delivered `cfg:` entries
  such as ADMIN_PASSWORD) all come back `[redacted]`; ids, emails, timestamps and row
  counts stay readable.

  **control-plane-api**'s error boundary now passes a `ControlPlaneError` through verbatim
  (status + message) instead of collapsing it into the generic 500 "internal error". A
  vertical's honest refusal — e.g. a 501 for a verb it does not implement — reaches the
  dashboard as itself; routes that already hand-caught it are unchanged.

- Updated dependencies [cd32011]
- Updated dependencies [ec89a88]
  - @substrat-run/contracts@0.15.0
  - @substrat-run/kernel@0.15.0

## 0.14.1

### Patch Changes

- cb6131c: docs: point every published package's `homepage` at its substrat.net page and
  swap the stale `substrat.ahlstrand.es` doc links in READMEs for `substrat.net`.
  Add the three missing READMEs (`engine-booking`, `cli`, `control-plane-api`).
  Metadata/docs only — no code or API change; a republish is needed for the
  updated README + homepage to render on npm.
- Updated dependencies [cb6131c]
  - @substrat-run/contracts@0.14.1
  - @substrat-run/kernel@0.14.1

## 0.14.0

### Minor Changes

- 6a7768a: Add a declarative environment surface to the module manifest, carried on the registry.

  - **`envVarSpec` / `EnvVarSpec`** and an optional **`envSpec`** block on `moduleManifest`: a
    vertical declares the environment it needs — key, label, description, placeholder,
    `required`, `secret`, `default`, `group` — self-describing so a host or console can render a
    config form and validate required keys before deploy. Additive-only (decision 28).
  - **`resolveEnvSpec(spec, raw)`** resolves a declared spec against a raw environment (a Worker
    `env`, `process.env`, …): it reads only the declared keys (so the manifest is the single
    source of what an app consumes), applies each `default`, and reports absent `required` keys
    without throwing.
  - **The registry carries a vertical's `envSpec`.** A new `env_spec` column is added
    additively to the vertical registry in both the SQLite and Cloudflare adapters;
    `registerVertical` stores the spec and an otherwise-identical re-registration refreshes it.
    This lets a host/console render a config form for any registered vertical — a bundled
    builtin or a pushed builder vertical — without loading its code.
  - **The push flow carries it.** The `deployManifest` accepts an optional `envSpec`, and the
    `/verticals/:slug/deploy` handler passes it through `registerVertical` — so a pushed
    vertical's declared config reaches the registry (and the dashboard form) like a builtin's.

- a1c7649: **A read-only "Data" tab: browse an app's own database from the dashboard.**

  Cashes in the seam kernel-design §5.4 reserved as the _admin-query RPC_ — a grant "is a
  tuple in the scope's own database and needs an admin-query RPC" — as two narrow,
  read-only `HostAdmin` primitives, `listScopeTables` and `readScopeTable`, and surfaces
  them as a **Data** tab on the app detail view (list tables, page through rows).

  Read-only and table-shaped **by construction**: the caller picks a table from the live
  schema plus a bounded page — there is no user-supplied SQL, so there is no write path to
  forge the spine and no injection surface. The `_substrat_*` spine reads back too, flagged
  `system` so the UI groups it apart from the vertical's own tables. Every read is audited
  (K-24) and fails closed on a mismatched `(tenantId, scopeId)` pair (K-3).

  **Reaches the data where it actually lives.** One dashboard app = one scope = one
  Durable Object = one database. In embedded mode the dashboard's own host owns that DO, so
  it reads directly. In connected/prod the scope's data DO lives in the _vertical's own WfP
  deployment_ (K-31), not the control plane's own (empty-module) scope host — so the
  control-plane `/tables` route **delegates to the vertical** through `VerticalClient`
  (`GET /internal/tables`), the mirror of `provisionInstance`. `getScopeRecord` does the
  K-3 check + audit and names the backing vertical; the same `verticals[slug] ??
resolveVertical` resolution provisioning uses reaches it; a co-located host falls back to
  reading its own scope DB. The dashboard never emits an empty `200` — a null from the
  platform surfaces as a clear `502` instead of an "Unexpected end of JSON input".

  Additive throughout: new optional `HostAdmin` methods implemented by both adapters (with
  a shared contract-tests suite), new `contracts` introspection schemas, and
  `/internal/tables[/:table]` on the vertical workers (Meridian, Callout). Editing rows and
  an arbitrary read-only SQL console are deliberately out of scope (fast-follows).

### Patch Changes

- f4ad677: **Data view: read a scope's BOUND version, not the prod channel.** The connected-mode
  `/tenants/:t/scopes/:s/tables` introspection route delegated to the vertical resolved by
  the vertical's `prod` channel. But each `substrat push` is a separate Workers-for-
  Platforms script with its own Durable Object namespace, so a scope's data DO lives in the
  deployment of the version it was **bound** to (`scope.verticalVersionId`) — the same one
  the router serves it from. Once an installed app lagged prod, introspection resolved to
  the prod deployment and read an empty DO.

  Adds an optional `resolveVerticalVersion(slug, versionId, actor)` to `ControlPlaneApiOptions`;
  the route now prefers it (keyed by the scope's bound version), falling back to the
  prod-channel `resolveVertical` for a scope with no bound version, then to the host's own
  scope DB. Behaviour is unchanged for a freshly-installed app (bound == prod). Closes #220.

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0
  - @substrat-run/kernel@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [74c9d7b]
  - @substrat-run/kernel@0.13.0
  - @substrat-run/contracts@0.13.0

## 0.12.0

### Minor Changes

- 05291fa: **Builder authz on the control-plane API (builder-plane.md Phase 2).** A second principal
  kind — a _tenant user_ — joins staff/service on the same surface, confined to the
  vertical-management routes and to the verticals their tenant **owns** (the `owner_tenant`
  column from Phase 1b). The mechanism ships tested against a stub; the real builder-session
  reader (session → user → selected tenant) and CLI wiring land with Phase 3.

  - **`authenticateBuilder?: BuilderAuth`** — a new, optional `createControlPlaneApi` option
    resolving a request to a `{ actor, tenantId }` builder principal. Tried only after
    `authenticate` (staff/service) declines, so staff auth is **unchanged** and remains a
    superset. Absent ⇒ the surface is staff/service-only exactly as before.
  - **Fail-closed confinement** — a builder reaches only an explicit allowlist of
    vertical-management routes (`GET`/`POST /verticals`, `…/versions`, `…/channels`, promote,
    deploy). Everything else — tenants, scopes, hostnames, admin-log, instance provisioning,
    and `versions/:id/{admit,reject}` — is `403` for a builder. Default-deny by design: a
    route not on the allowlist denies builders (a missing feature), never escalates.
  - **Ownership checks** — register/deploy **claim** an unregistered slug for the caller's
    tenant or require they already own it (`403` otherwise); publish/promote require ownership;
    `GET` of an unowned vertical is `404` (indistinguishable from absent, K-3's reflex). The
    owner is stamped from the principal, never trusted from the body. Staff pushes preserve the
    existing owner rather than clobbering it.
  - **Model B, staff keep the prod gate** — a builder self-serves `dev`/`staging` promotion;
    **`prod` promotion and admission stay staff-only**, the trust boundary self-serve-deploy.md
    §3 draws.
  - **`GET /verticals`** is filtered to the caller's owned verticals for a builder; staff see
    the whole registry.

  Internally the auth middleware now sets both `actor` (the audited subject, unchanged for
  every HostAdmin call) and a new `principal` (the authz distinction) — existing routes are
  untouched. `errors.ts` maps the Phase-1b claim conflict (`is owned by …`) to 409.

  Verified: control-plane-api suite (71) incl. a new builder-authz matrix — claim, cross-tenant
  refusal, list filtering, non-prod self-serve, staff-only prod/admit, deploy-path claim — and
  the control-plane worker suite (13) both pass; `pnpm -r typecheck` clean.

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

- 7070588: **Push forwards `compatibility_flags`, and the deploy endpoint surfaces upload failures.**

  A pushed vertical that needs a compat flag — `nodejs_compat` for Better Auth / any `node:*` import — was being uploaded **without** it: the CLI manifest, the deploy schema, and the WfP metadata all carried only `compatibility_date`. So the script couldn't start, Cloudflare rejected the upload, and `deployVertical` threw — which the generic handler flattened into an anonymous `500 {"error":"internal error"}`, undiagnosable without worker logs. Callout hit exactly this.

  - **`compatibility_flags` now travels end to end**: `substrat push` reads it from `wrangler.jsonc` into the manifest (`deployManifest`/`VerticalBundle` gain `compatibilityFlags`), and `createWfpUploader` emits it in the script metadata.
  - **The deploy endpoint wraps `deployVertical`** and returns **`502 { error, detail }`** with the runtime's actual message (the builder is authenticated — this is platform/runtime error detail, not a bad request), plus a `console.error`, instead of a blank 500.

  Verified: control-plane-api suites pass, including new tests that `nodejs_compat` survives to the uploader and that an upload failure surfaces as a 502 with detail.

- 66e752b: **Add the deploy seam: `POST /verticals/:slug/deploy` (self-serve-deploy.md foundation).**

  A `substrat push` uploads a _built_ worker bundle to this endpoint, which validates the
  **sandbox contract**, forwards the bundle to an injected uploader (the host holds the
  Cloudflare credential — the builder never does, D-34), and records a **pending** version.
  A push is not a deploy; admission still gates serving.

  - New `deployVertical?: DeployVerticalFn` option — injected so the package holds no
    Cloudflare SDK and is unit-testable with a fake. Absent ⇒ the route 501s.
  - `assertSandboxContract` (self-serve-deploy.md §4): refuses an upload whose declared
    bindings would reach platform infrastructure — a `CONTROL_PLANE` binding, a cross-script
    DO binding, or a service binding to a platform worker → `403`. Structural refusal, not
    code inspection, is the primary defence against untrusted bundles.
  - `deploymentRef` is `<slug>-<versionId>` (a lowercased ULID) — a valid Cloudflare Worker
    script name, unlike the `@version` label the RFC sketched (`@`/`.` are illegal in script
    names). The human label stays on the version record.
  - Exports `assertSandboxContract`, `deployManifest`, `deploymentRefFor`, and the
    `DeployVerticalFn` / `VerticalBundle` types for hosts to implement the real uploader.
  - `createWfpUploader({ accountId, namespace, apiToken })` — a `DeployVerticalFn` that
    uploads the bundle into a Workers-for-Platforms dispatch namespace (pure `fetch` +
    `FormData`, so it runs in a Worker or node). Wired into `apps/control-plane` (behind the
    `CF_API_TOKEN`/`CF_ACCOUNT_ID` env) and the dev server. The `tools/substrat-push.mjs` CLI
    builds a vertical and pushes it to `/verticals/:slug/deploy`.
  - New `resolveVertical?: (slug, actor) => Promise<VerticalClient | undefined>` option — the
    provisioning dispatch swap (orchestration.md §5.4), tried after the static `verticals` map.
    `apps/control-plane` resolves a pushed vertical's `prod` version → `env.DISPATCH.get(ref)`,
    so `POST /verticals/:slug/instances` reaches a pushed vertical with no redeploy.

- cedaf1a: **Deploy path forwards a vertical's own D1 bindings (self-serve-deploy.md §4).**

  A `substrat push` now carries a vertical's `d1_databases` through to the Workers-for-Platforms upload, so a pushed vertical actually has its own data stores — not just its `ScopeDO`. This is what a CP-less vertical like Callout needs for its Better-Auth `AUTH_DB` to exist on the deployed worker.

  - **`DeclaredBinding` / `deployManifest`** gain an optional `id` — a `d1` binding's `database_id`, which previously would have been stripped at manifest parse.
  - **`tools/substrat-push.mjs`** maps `wrangler.jsonc`'s `d1_databases` to `{ type: 'd1', name: <binding>, id: <database_id> }` bindings alongside the DO bindings; `createWfpUploader` already forwards the binding set verbatim into the script metadata, which is the shape Cloudflare expects for a D1 binding.
  - **`assertSandboxContract`** still refuses only the platform's infrastructure (`CONTROL_PLANE`, service bindings, cross-script / foreign DO classes); a vertical's own `d1` store falls through and is allowed, matching §4 ("no `AUTH_DB` it did not create" — its own is fine). Documented open question: this check doesn't yet prove the vertical _owns_ the declared `database_id` rather than pointing at another tenant's DB — under model B that gap is closed by human admission, and by per-vertical store provisioning when self-serve opens wider.

  Not covered here (a separate mechanism, tracked next): **static assets.** A pushed vertical's SPA is not a binding — Cloudflare uploads it via a blake3-hashed assets-upload-session, which needs a server-side implementation in the uploader. Callout still needs that before it serves its UI from the dispatch namespace.

  Verified: control-plane-api suites pass, including a new deploy test that a `d1` binding (with its `database_id`) is accepted by the sandbox contract and forwarded to the uploader.

- 0de890b: **The platform injects `PLATFORM_SECRET` + `ROUTER_SECRET` into every pushed vertical.**

  A pushed vertical needs the platform's shared secrets to _verify_ inbound calls — `PLATFORM_SECRET` to accept the control plane's `/internal/provision` (K-31), `ROUTER_SECRET` to trust the router-asserted node (K-27). But `wrangler secret put` can't target a WfP dispatch-namespace script, so there was no clean way to set them per-vertical. And they aren't the builder's secrets — they're the platform's.

  - **`createWfpUploader` gains `injectSecrets`** — a name→value map added as `secret_text` bindings on every uploaded script. Injected server-side, _after_ the §4 sandbox check on the vertical's declared bindings (the platform is granting verification secrets, not the vertical reaching for a platform binding). Empty values are skipped.
  - **The control plane passes `env.PLATFORM_SECRET` + `env.ROUTER_SECRET`** into the uploader, so a pushed vertical is provisionable + servable with zero per-vertical secret setup.

  Set both on the control plane, redeploy, and re-push a vertical — it comes up holding the secrets it needs. Verified: control-plane-api suites pass, including new tests that the secrets land as `secret_text` bindings beside the vertical's own, and that an unset one is skipped.

- d5a7d5e: **Expose the vertical + version registry over the control-plane HTTP API (orchestration.md Phase 1a).**

  The registry data model — verticals, versions, channels, admission, and the digest-diff
  promotion gate — was already built at the `HostAdmin` + adapter layer but had no HTTP
  surface. This adds thin pass-through routes so a staff caller (and the console) can drive it:

  - `GET/POST /verticals` — list, register
  - `GET/POST /verticals/:slug/versions` — list, publish (lands **pending**; body slug must
    match the path, K-3-style cross-check)
  - `POST /verticals/:slug/versions/:id/{admit,reject}` — the admission checkpoint
  - `GET /verticals/:slug/channels` + `POST /verticals/:slug/channels/:channel/promote` — the
    promotion checkpoint, which refuses a changed permission/migration digest unless
    acknowledged
  - `POST /tenants/:tenantId/scopes/:scopeId/version` — bind a scope to an admitted version

  `errors.ts` gains status mappings so registry refusals surface as `404`/`409` rather than
  `500`. No `deploy` route (the worker uploader) — that is Phase 2. The actor is still stamped
  from the authenticated request, never the body.

### Patch Changes

- 097a3aa: **`deploymentRefFor` is prefix-safe** — builder plane Phase 1 groundwork.

  A builder-owned vertical's slug will be `<tenant>/<name>` (builder-plane.md). The
  dispatch script name must stay Cloudflare-safe (`[a-z0-9_-]`), so `deploymentRefFor`
  now flattens the `/` (and any other stray char) to `-`. A bare platform slug is
  unaffected (`callout-<id>`), so it's fully backward-compatible.

- 0572a3b: **Typecheck on the native (Go) TypeScript compiler — `typescript` 5.6 → 7.**

  TypeScript 7 (the native compiler, formerly the `tsgo`/`@typescript/native-preview`
  rewrite) is now GA as `typescript@latest`. The binary is still `tsc`, so every package's
  `tsc -p … --noEmit` script is unchanged — only the toolchain pin moves. No source or
  public API changes; this bumps the published packages solely because their build now runs
  through the native compiler.

  Full-workspace `pnpm -r typecheck` drops to ~3s wall; per-package the native checker is
  roughly an order of magnitude faster (kernel 1.33s → 0.07s, control-plane-api 1.50s →
  0.12s, engine-invoicing 0.91s → 0.06s on this machine).

  Two migration deltas TS7's stricter resolution surfaced (both green on 5.6, red on 7):

  - **CSS side-effect imports (`TS2882`).** `import './ui.css'` in the six Vite app/admin
    surfaces now needs an ambient declaration. Fixed the way `demos/meridian/app` already
    did it — `"types": ["vite/client"]` in each app `tsconfig.json` (vite/client declares
    `*.css`) — rather than adding a stray `vite-env.d.ts`.
  - **`boundary-lint` node globals (`TS2584`/`TS2591`).** The linter CLI's `process`,
    `console`, and `node:fs`/`node:path` imports stopped resolving because the base tsconfig
    leaves `types` unset and TS7 no longer implicitly pulls in `@types/node` here. Added an
    explicit `"types": ["node"]` to `packages/boundary-lint/tsconfig.json`.

  Note: TS7 is a major bump that drops deprecated 5.x behavior. Editors should run their
  TS Server on 7 to keep CLI and IDE diagnostics aligned.

- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
- Updated dependencies [66e752b]
- Updated dependencies [0572a3b]
  - @substrat-run/contracts@0.12.0
  - @substrat-run/kernel@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/kernel@0.11.0
  - @substrat-run/contracts@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/kernel@0.10.0

## 0.9.0

### Minor Changes

- 27872cc: Scopes are provisioned as `provisioning` and activated on confirmation (K-31).

  `provisionScope` wrote the directory row as `active`, so the row claimed a usable
  scope before anything had built one — and only the vertical can build one, because the
  DO class bundles the modules and lives in the vertical's deployment. The `provisioning`
  state existed in the enum for exactly this and was unused.

  `HostAdmin.activateScope` moves `provisioning → active`, through the same transition
  graph the other lifecycle moves use, so it is audited and cannot revive a suspended
  scope. `getScope` refuses anything not active, so an unconfirmed row is inert rather
  than misleading.

  `ControlPlaneClient.activateScope` is the push-mode equivalent, and the control-plane
  API gains `POST /tenants/:t/scopes/:s/activate`.

  Migrations are still attempted for a `provisioning` scope before it is refused, so the
  lazy retry and its attempt counter survive — they are the only self-healing there is
  until the reconciliation sweep exists. A scope held back by a failed migration now
  reports the migration error rather than a bare "not active".

### Patch Changes

- Updated dependencies [27872cc]
  - @substrat-run/kernel@0.9.0
  - @substrat-run/contracts@0.9.0

## 0.8.0

### Minor Changes

- c9fe555: `VerticalClient` and `POST /verticals/:slug/instances` — the platform's side of K-31.

  Provisioning is control-plane-driven because only the vertical can create a usable
  scope DO: the DO class bundles the modules and lives in the vertical's own deployment.
  This is the mirror of `ControlPlaneClient`, pointing the other way — that one is a
  vertical talking up to the platform, this is the platform telling a vertical to act.

  Deliberately tiny. Provisioning is the only thing the platform asks a vertical to do,
  and every additional verb would be authority the platform holds over someone else's
  code.

  `createControlPlaneApi` takes an optional `verticals` map. A slug with no binding gets
  a **501** rather than a silent success: a control plane that does nothing while
  reporting success is worse than one that says it cannot. The vertical's own status is
  propagated rather than flattened to 500, because a 403 means the platform secrets do
  not match — a deployment error someone must act on.

### Patch Changes

- @substrat-run/contracts@0.8.0
- @substrat-run/kernel@0.8.0

## 0.7.0

### Minor Changes

- 017bb83: The hostname map is on the audited HTTP surface: `GET /hostnames`,
  `POST /hostnames`, `PATCH /hostnames/:hostname/status`.

  `resolveHostname` is deliberately **not** here. It is the router's per-request machine
  path, unaudited by design (K-24), and the router reads the directory directly. Putting
  it on the staff surface would either flood the admin log or quietly add an unaudited
  route to a surface whose whole claim is that it is audited.

  `ControlPlaneClient` is unchanged: that is the _vertical's_ client, and a vertical
  assigning itself a domain is not a thing we want to be possible.

### Patch Changes

- Updated dependencies [c54637b]
- Updated dependencies [8c48c93]
- Updated dependencies [33fb5dd]
  - @substrat-run/contracts@0.7.0
  - @substrat-run/kernel@0.7.0

## 0.6.0

### Minor Changes

- ea3c5de: Service auth for connected verticals, and a workerd fetch fix.

  - `serviceTokenAuth` + `SERVICE_TOKEN_HEADER` — a shared-token credential a
    vertical presents to register into the control plane (a service, not staff),
    and `firstPlatformActorAuth` to compose it with session/dev auth.
  - `ControlPlaneClient` gains a `serviceToken` option (sent as `x-service-token`).
  - **Fix:** `ControlPlaneClient` bound `globalThis.fetch` incorrectly, throwing
    "Illegal invocation" on workerd. It is now bound to the global scope, so the
    client works inside a Worker (over a service binding or plain fetch).

### Patch Changes

- @substrat-run/contracts@0.6.0
- @substrat-run/kernel@0.6.0

## 0.5.0

### Minor Changes

- 54c6583: Add the vertical-side connect seam and swappable staff auth.

  - `ControlPlaneClient` — a typed HTTP client that registers a tenant, entitlements,
    and scope into a separately-run control plane, plus `assertScopeActive`, a gate
    that fails closed on the directory's authoritative lifecycle (tenant-level
    cascade included). `fetch` is injectable.
  - `sessionPlatformAuth(readSession, resolveActor)` + `staffAllowlist` — the real
    `PlatformActorAuth` for platform staff, split so the auth provider and the staff
    roster are independent. Swapping the provider (e.g. to AuthHero) changes only the
    session reader.

### Patch Changes

- @substrat-run/contracts@0.5.0
- @substrat-run/kernel@0.5.0

## 0.4.0

### Minor Changes

- 6900431: The directory becomes readable, and gets an HTTP surface.

  **New package: `@substrat-run/control-plane-api`** (AGPL-3.0-only + commercial,
  like the kernel it sits on). One Hono router over `HostAdmin` — the audited
  control-plane transport. Web-standard only, so the same router mounts in a Worker
  holding the `controlPlane` binding or behind a Node server. It is not module code:
  it never receives a `ctx` and never runs in a scope's serialization domain.

  **`HostAdmin` gains a read side.** The write side was complete; nothing could
  enumerate what it had written.

  - `listScopes(filter?)` / `getScopeRecord(tenantId, scopeId)` — the scope
    inventory §3.2 always claimed the directory was. `getScopeRecord` cross-checks
    the pair and returns `undefined` for another tenant's scope, the same
    fail-closed rule `getScope` applies (K-3).
  - `listRoles(filter?)` — roles were writable and not enumerable since the
    permission model shipped. Returns `TenantRole` (a `RoleDefinition` plus its
    tenant).
  - `auditLog(filter?)` widens: filter by scope, actor, action or time; `limit`,
    `cursor` and `order`. The cursor is the entry's own ULID — order is
    chronological, so a page carries its own continuation. **The default order is
    unchanged** (oldest first), so existing callers do not shift.

  **The `scope` contract is now enforced rather than aspirational.** It described
  `slug`/`kind`/`name`/`parentScopeId` and was parsed by nothing while the table had
  none of those columns. Every read now parses through it, and `Scope` gains
  `vertical`.

  **`ProvisionScopeInput` extends additively** — `slug`, `kind`, `name`, `vertical`
  are optional with behaviour-preserving defaults, so existing callers are
  untouched. An unnamed scope's slug defaults to its lowercased id (a ULID
  lowercases into a valid slug, so it is valid and unique by construction).

  **`schemaVersion` and `vertical` stop being placeholders.** Both shipped as
  columns written by nothing — `schemaVersion` was always `'0'`, `vertical` always
  `null`. `schemaVersion` is now the applied-migration count; `vertical` is stamped
  onto audit targets for scope-lifecycle actions.

  **Directory schema change, applied in place by both adapters.** The `scopes` table
  gains `parent_scope_id`/`slug`/`kind`/`name`/`vertical`, plus a unique index on
  `(tenant_id, slug)` and one on `tenants(slug)`. The directory is not a module and
  has no `SqlMigration[]` journal, so each adapter upgrades on open: add the columns,
  backfill legacy rows to the same defaults `resolveScopeRecord` applies, then create
  the unique indexes **after** the backfill (a unique index over NULL slugs would
  permit the duplicates it exists to forbid). No action is required of callers; an
  existing directory opens and migrates itself.

  **Slug uniqueness is now enforced**, which it never was despite the contract saying
  "unique within tenant". `createTenant` and `provisionScope` fail closed on a
  collision rather than reporting a silent no-op — `INSERT OR IGNORE` would have
  swallowed a colliding-slug-different-id create and reported it as idempotent.

### Patch Changes

- Updated dependencies [6900431]
  - @substrat-run/contracts@0.4.0
  - @substrat-run/kernel@0.4.0
