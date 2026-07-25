# @substrat-run/contracts

## 0.14.1

### Patch Changes

- cb6131c: docs: point every published package's `homepage` at its substrat.net page and
  swap the stale `substrat.ahlstrand.es` doc links in READMEs for `substrat.net`.
  Add the three missing READMEs (`engine-booking`, `cli`, `control-plane-api`).
  Metadata/docs only — no code or API change; a republish is needed for the
  updated README + homepage to render on npm.

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

- 1022c15: **Registry-driven marketplace, phase 2** (marketplace-publish.md §3) — the dashboard's hardcoded
  `CATALOG` map is no longer a gate, so a pushed → promoted → published vertical shows and installs
  with **no dashboard change**.

  - Registry `vertical` gains a `listed` flag (published to the public marketplace) — its own
    column adapter-side (sqlite + cloudflare), set on insert and **never clobbered by a re-push**
    (publish is a distinct action from push).
  - `availableCatalog` is registry-driven: a vertical shows if it's `listed` **or** owned by the
    caller's tenant (private to your team). Takes the caller's `tenantId`.
  - `createApp`/retry read `entitlements`/`ownerGrants` from the registry row (via `installSpecFor`),
    falling back to `CATALOG` for a first-party not yet re-seeded.
  - `ensureCatalog` seeds first-party verticals with their specifics and `listed: connected !== false`,
    so the `CATALOG` map is now just a first-party **seed**, not a visibility/install gate.

  Removes the recurring "add a catalog entry + redeploy the dashboard" step. Phase 3 (the
  staff-reviewed publish action) flips `listed` for builder verticals.

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

## 0.13.0

### Minor Changes

- 74c9d7b: Add `unassignRole` and `unlinkIdentity` to the `HostAdmin` surface — the inverses of `assignRole` and `linkIdentity`, so authority granted through the kernel can also be taken back.

  - `unassignRole(actor, assignment)` revokes a role assignment by tombstoning the role tuple (K-21): the checker stops resolving it, the tuple stays as audit evidence, and a later `assignRole` of the same `(principal, role, node)` reactivates it. Idempotent.
  - `unlinkIdentity(actor, tenantId, principal)` severs a principal's login from a tenant — keyed by principal (so the caller needs no external subject) and a DELETE rather than a tombstone, so `listIdentityTenants`/`resolveIdentity` stop returning it and a re-invite can re-link a fresh principal.

  Both are implemented in the SQLite and Cloudflare adapters (with a generic tenant/scope tuple revoke on the Cloudflare DOs) and add matching `adminAction` log entries. Together they unblock self-serve member removal: cut a member's access and drop the team from their surface.

## 0.12.0

### Minor Changes

- 73c0cdb: **A vertical now records its owning tenant (builder-plane.md Phase 1b).** The registry
  gains an `owner_tenant` column: `NULL` = platform-owned (Callout, the dashboard), a value
  = the tenant that pushed it. Ownership is the gate a later phase checks for who may push
  new versions and manage a vertical's non-prod channels.

  - **`vertical.ownerTenant`** (contracts) — nullable branded `TenantId`; `registerVerticalInput`
    takes it optional (defaults to `null`, so a staff/platform push keeps passing
    `{slug, name, source}` unchanged).
  - **Migration in each adapter** — `owner_tenant TEXT` added idempotently to the `verticals`
    table (`ensureDirectoryColumns` in sqlite, `addColumn` in `control-plane-do`), so an
    existing directory backfills to platform-owned.
  - **Claim-on-first-push** — `registerVertical` fixes a slug's owner at first push: a later
    registration under a _different_ owner (or an attempt to claim a platform vertical) is
    refused, naming both owners. Identical re-registration stays idempotent.

  The `<tenant>/<name>` slug prefix that keeps builder slugs globally unique is constructed at
  push time in a later phase; this change is the ownership column + claim mechanism it rests on.

  Verified: sqlite (147) + cloudflare (146) suites pass, including a new shared assertion that
  a registered owner round-trips through `listVerticals` and that a conflicting owner is refused.

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

- 66e752b: **The router dispatches on the scope's bound version (orchestration.md Phase 3, §5.4).**

  `routeTarget` gains `deploymentRef` (nullable): the dispatch script the scope's bound
  version deploys as. The directory read (`resolveHostname` / `readHostname`) now LEFT-joins
  `scope → vertical_version` to resolve it in the same one DO call, so the hot path stays a
  single read.

  The router's `verticalFor` becomes `env.DISPATCH.get(deploymentRef)` when the namespace is
  bound and the scope has a version — the one-line swap K-28 anticipated — falling back to the
  static `VERTICAL_<SLUG>` service binding for a route with no version. A pushed vertical is
  now reachable through the router without redeploying it. The bounded `Worker not found.`
  retry (K-29), armed since K-28, is now live: it fires on the dispatch path.

  Adapters (`adapter-sqlite`, `adapter-cloudflare`) version with contracts (fixed group).

### Patch Changes

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

## 0.11.0

### Minor Changes

- 858912e: **`jurisdiction` is now `eu | us | global` (non-nullable), defaults to `global`, and `eu`/`us` are gated at the provisioning boundary (K-32).**

  Jurisdiction is fixed at provisioning and a scope's DO can never relocate (K-7), so
  the storable vocabulary has to be final before the first production scope exists —
  widening what can be _stored_ later is a data migration, widening what is _accepted_
  is a one-line change. Two findings forced the shape:

  - **It was recorded but never enforced.** The only DO id minting is
    `idFromName(scopeId)`; `newUniqueId`/`ns.jurisdiction(...)` appears nowhere but a
    deferral comment. So `eu` on a scope today moves no storage and terminates no TLS.
  - **`z.enum(['eu']).nullable()` made `null` mean both "unconstrained" and "nobody
    decided"**, and the provisioning input defaulted to it — so absence silently
    became a residency posture.

  So: `jurisdiction = z.enum(['eu','us','global'])`, non-nullable, defaulting to
  `global` (the honest name for what every scope already is — no subnamespace, placed
  near first access). Legacy `null` rows coerce to `global` on read in both adapters.
  A separate `provisionableJurisdiction = z.enum(['global'])` gates the control-plane
  HTTP boundary: `eu`/`us` are storable but refused with 400 until their enforcement
  (DO jurisdiction subnamespace, Regional Services) is built — `us` is not even a
  Cloudflare DO jurisdiction, so it is a different mechanism behind the same word.
  Gated exactly as `STANDALONE`/`ALLOW_DEV_HEADER` are (K-31).

  No SQL migration: the columns were already nullable `TEXT`. The console's create
  dialog gains a jurisdiction picker with `eu`/`us` shown-but-disabled, so the roadmap
  is visible where the choice is made. Deriving `hostnameRegion` from the scope
  (rather than accepting it separately) is the natural follow-up and is deferred — it
  is not immutability-sensitive.

  The `@substrat-run/*` published packages version together (changesets `fixed`
  group), so kernel, adapter-sqlite, adapter-cloudflare, contract-tests, and
  control-plane-api move with contracts.

## 0.10.0

### Minor Changes

- 9c1f0bb: **The connection store, and the first encryption primitive in the codebase.**

  Per-tenant credentials for external providers had nowhere to live. `master-plan.md §6`
  committed to a connection store; `kernel-design.md §1` deferred "the integrations hub beyond
  its contract stub", and the stub was never written either — no `Connection` type, no
  credential storage, nothing.

  **Keyed on (tenant, vertical, provider)**, not tenant alone. A vertical is a blast-radius
  boundary (D-30) and verticals are built by different companies (D-33), so one vendor's host
  code must not reach a credential another vendor connected for the same tenant. It also
  matches how OAuth issues clients. Cross-vertical sharing, if a real case ever appears, is an
  explicit grant rather than the default.

  **`SecretBox` is a new adapter surface** — D-18 classifies the KMS as an adapter. Before this
  every `crypto.subtle` call in the repo was a one-way digest and every secret was a plaintext
  Worker binding: nothing per-tenant, nothing rotatable, nothing encrypted at rest.
  `webCryptoSecretBox` (AES-256-GCM, fresh IV per seal, key id for rotation) is the default;
  Cloudflare Secrets Store or an external KMS drop in behind the same interface. A host with no
  `SecretBox` **refuses to store a credential** rather than storing one in the clear.

  Two leaks designed out rather than remembered:

  - `_substrat_admin_log.before`/`after` take arbitrary JSON and the log is **append-only**, so
    a credential written there could never be removed. Connection mutations log metadata only.
  - `adminAction` is a closed enum that `auditLog` parses _every_ row through, so unrecognised
    actions fail the read of the whole log. Three members added.

  Revoking **destroys the sealed blob** and tombstones the row: a grant that once existed is
  evidence of why an access was allowed (K-21), but keeping the usable credential would make it
  a liability. Uniqueness is over live rows, so a revoked connection can be replaced.

  New on `HostAdmin`: `createConnection`, `listConnections`, `updateConnectionSecret`,
  `revokeConnection`, `openConnection`, `recordConnectionUse`. `openConnection` takes no actor
  and is not audited — the same exemption `resolveHostname` and `resolveIdentity` hold, for the
  same reason: an audit row per outbound HTTP call would drown the log that matters. Health
  (`lastOkAt`/`lastError`) is what an operator can act on instead.

  Ten new **contract** tests, so both adapters must agree — including that the credential
  appears in neither a metadata read nor the audit log, that another vertical cannot open it,
  and that revoking destroys it.

  **These methods take a `PlatformActorId`, which is a deliberate deferral, not an answer.**
  Connecting a provider is a tenant admin's act, and routing it through a platform actor is the
  defect D-31 named for `addMember`. Recorded in `docs/design/connections.md` §3.5; no console
  flow should be built on this signature until the question is settled with membership's.

- 113160a: **The inbound authority seam (#97): a connection is a subject.**

  A provider's callback has to write back into a scope, and it is not a person. `getScope`
  demands a `PrincipalId`, so a connector could dispatch a document and then be unable to record
  that it had — which under at-least-once delivery means a retry sends a **second** one.

  ```ts
  getConnectorScope(connectionId, scopeId): Promise<ScopeStub>;
  grantToConnection(actor, grant): Promise<void>;
  ```

  **The door inherits its narrowing.** A connection is keyed (tenant, vertical, provider), so
  `getConnectorScope` refuses another tenant's scope, another vertical's scope, and a revoked
  connection — none of it re-declared, just the key enforced where it could have been widened.

  **Authority is an ordinary permission grant**, not a second mechanism. Tuples already expire,
  tombstone on revoke (K-21), carry a proof, and appear in the permission diff. A parallel
  "allowed operations" list — the first design — would have been a second gate that only one of
  the two would show up in a review.

  **A connection is not a person, and the model now says so.** `PermissionChecker.check` takes a
  `CheckSubject` (`{ kind: 'principal' } | { kind: 'connection' }`) instead of a `PrincipalId`.
  Minting a principal per connection would have been cheaper and wrong: every audit view would
  show a `principal:` subject for something that is not one — the confusion `PlatformActorId`'s
  separate brand exists to prevent. So the tuple proof reads `connection:01J…`, the event actor
  is `{ connection }` beside the existing `{ system }`, and membership expansion is skipped for a
  connection rather than queried — it belongs to no org and holds no role, so a role carrying a
  permission cannot leak into it.

  **Breaking for custom checkers.** Any `PermissionChecker` implementation must take a
  `CheckSubject`; `asPrincipal(id)` is exported for the common case. Both built-in adapters and
  the contract suite are updated.

  Five new tests in the permission contract suite, against the real tuple checker on both
  adapters: opening the door confers nothing · a grant allows exactly what it names and proves it
  with a `connection:` tuple · no roles or memberships leak in · another tenant's or vertical's
  scope is unreachable · revoking the connection closes the door in the same act that destroys
  the credential.

## 0.9.0

## 0.8.0

## 0.7.0

### Minor Changes

- c54637b: The hostname map: `hostname → (tenant, scope, vertical, surface, region)`.

  A provisioned scope had no URL, so "validate it works in production" had nowhere to
  point. `contracts/routing.ts` adds `hostnameBinding` and `routeTarget`, and `HostAdmin`
  adds `bindHostname` / `setHostnameStatus` / `listHostnames` / `resolveHostname`.

  `surface` is the correction: one hostname per scope was already wrong, because a single
  scope fronts a storefront and a back office, or a player app and a manager console.

  `region` sits on the binding rather than in a router deployed per jurisdiction, because
  Cloudflare's Regional Services is configured per hostname — residency is one more
  column, not a second topology.

  Bindings have a lifecycle (`pending` → `verifying` → `active`, or `failed` with a note),
  since a custom domain is DNS validation and certificate issuance rather than a string
  somebody sets. Only `active` resolves. `resolveHostname` takes no actor and is not
  logged — the machine-path carve-out `resolveIdentity` already has — and does not
  re-check suspension, which `getScope` owns.

  Additive on every published surface: new schemas, new `HostAdmin` methods, new tables.
  Nothing existing changed shape.

### Patch Changes

- 33fb5dd: Verticals can serve more than one tenant: the router's side of K-26, plus K-27.

  `@substrat-run/kernel` exports **`readRoutedNode`**, which reads the `(tenant, scope,
surface)` a router asserted in `x-substrat-*` headers and decides whether to trust it.
  Three outcomes, kept distinct: `null` when no router fronted the request (a standalone
  deploy substitutes its own node), a throw when the assertion is present but unsigned,
  incomplete or malformed, and the node when it is good. Collapsing the middle case into
  `null` would let a forged assertion fall through to whatever the caller does for
  "unrouted".

  Trust comes from a shared secret, compared in constant time. K-26's real boundary is
  that vertical workers have no public route — but that is a deployment fact and
  `workers.dev` is on by default, so the secret is what makes the boundary hold in code
  when the configuration slips.

  `@substrat-run/adapter-cloudflare` adds a **`/routing` subpath export** with
  `createRouteResolver`: hostname → route target over the control-plane DO, and nothing
  else. The package root re-exports the scope-DO class, which a router must not carry —
  it resolves a name and forwards, and should not be able to open a scope at all.

  `@substrat-run/contracts` now **normalizes hostnames to lower case** in the schema.
  DNS is case-insensitive, so storing `ACME.example.com` and `acme.example.com` as two
  rows would let two scopes each hold "the same" hostname and let a request resolve to
  whichever casing it arrived in.

  Additive: new exports and a new subpath. Nothing existing changed shape.

## 0.6.0

## 0.5.0

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

## 0.3.0

### Minor Changes

- 5dd4085: Zod 4, and `contracts` re-exports `z` — closing a live from-scratch trap

  **The trap.** The published packages depend on `zod ^3.25.0` while `pnpm add zod`
  — which getting-started told users to run — installs Zod 4. pnpm resolves both:
  Zod 3 nested for our packages, Zod 4 for the user. Two copies, both "correct".
  Zod schemas do not compose across majors, so the moment a user wrote the pattern
  CLAUDE.md mandates ("operation inputs go through Zod schemas at the boundary")
  composing a contracts schema into their own —

                              z.object({ facility: entityRef, unitPrice: money })

  — it failed at RUNTIME with `Invalid element at key "facility": expected a Zod
schema`, an error pointing nowhere near the cause. Not an exotic pattern: it is
  what `engines/workorder` itself does (`unitPrice: money`, `facility: entityRef`),
  so anyone copying the reference hit it immediately. Found by building a vertical
  from scratch against the published packages — the flow the docs describe and
  nobody had walked.

  **Two fixes, because they solve different halves.**

  1. **Zod 4 everywhere.** Aligns with what the ecosystem installs by default, so a
     user who reaches for `zod` gets our major. No code changes were needed — the
     schema subset in use (`z.object`, `.regex`, `.brand`, `.min`, `.optional`,
     `z.infer`) is stable across the major, and the one `z.record` was already the
     2-arg form Zod 4 requires. Build, typecheck, and the full suite pass unchanged.
  2. **`contracts` re-exports `z`.** The durable half: importing `z` from
     `@substrat-run/contracts` means the consumer never installs zod at all, so the
     versions cannot diverge. Fix 1 makes the trap dormant; fix 2 keeps it dormant
     when Zod 5 ships.

  `zod` is dropped from the getting-started install line; docs and the `substrat`
  skill both import `z` from contracts.

  **Breaking for consumers on Zod 3** — deliberately taken now, while there are
  effectively none, rather than later when there are.

  **Still open:** making `zod` a `peerDependency`. Contracts' schemas are part of
  its public API — consumers are meant to compose them, so their copy must be ours
  — which is textbook peer. As a plain dependency it nests silently instead of
  failing at install. Left as a separate call.

## 0.2.1

### Patch Changes

- d929987: Control plane §4.3: entitlement store — `manifest.entitlementKey` finally gates loading

  `manifest.entitlementKey` was declared on every module and read by nothing (D-20
  was a promise with no mechanism). Now a per-tenant `_substrat_entitlements` set
  gates module loading, default-deny: an operation whose owning module's SKU flag
  the tenant does not hold does not resolve — the same fail-closed shape as manifest
  `withdraws`. New `HostAdmin.grantEntitlement`/`revokeEntitlement` (idempotent,
  audited) and `listEntitlements`. The check runs per invoke (the simple, uncached
  path — a DO-cached variant is kernel-design open question 5). Entitlement flags
  are the SKUs meter 2 (§5) counts. Demo seeds grant the flags for the modules each
  vertical runs — the SKU model in use.

- f717014: Control plane §4.4: `PlatformActor` seam + append-only admin audit log (D-30, K-20)

  Every `HostAdmin` mutation (defineRole / assignRole / grant / grantToOrg / addMember)
  now takes a `PlatformActorId` — a staff subject branded distinctly from a tenant
  `PrincipalId` — and writes an append-only row to a new `_substrat_admin_log` in the
  directory, stamped host-side (actor, action, target, before/after, timestamp). A new
  `HostAdmin.auditLog(filter?)` reads it back — the read path for the console history and
  the permission-diff human checkpoint. `defineRole` captures the prior role in `before`.

  Pre-release breaking surface change kept at patch: `HostAdmin` method signatures gained
  a leading `actor` argument. Locally the actor is a dev stub; real staff auth gates
  exposing the surface, not building it.

- 6393a8e: Control plane §4.2: scope lifecycle + structural audit + mandatory tenant

  `provisionScope` becomes the first audited scope-lifecycle transition — it now
  takes a `PlatformActor`, requires an existing active tenant (a scope with no
  tenant record fails closed), and audits. New `HostAdmin.suspendScope`,
  `unsuspendScope`, `archiveScope`, and `unarchiveScope` implement the §3.3
  transitions, validate the legal transition graph (fail closed on an illegal
  one), and audit before/after; un-archive is an explicit restore, never a silent
  flag flip. `getScope` now gates on both tenant-active AND scope-active, so
  suspend/archive actually contain.

  Audit is now a single `recordAdmin` choke point every mutation routes through —
  "no mutation without a durable record" holds by construction, not per-method
  discipline. The step-2 "legacy scopes without a tenant" passthrough is removed:
  every scope has a tenant with a status.

- 2dd4175: Control plane §4.1: tenant registry + lifecycle status

  A real `tenants` table in the directory replaces "a tenant is a ULID nobody used
  before". New `HostAdmin.createTenant` (idempotent, audited), `setTenantStatus`,
  `listTenants`, and `getTenant`. A tenant whose status is not `active` fails
  `getScope` closed for every scope under it — the K-3 fail-closed path, the
  containment lever for non-payment or an incident, reversible without deletion.
  Scopes provisioned without a tenant record (legacy path) are not gated, keeping
  the change backward-compatible.

## 0.2.0

### Minor Changes

- 604883b: Manifest-declared operation guards and operation withdrawal — compliance gates a reviewer can enumerate.

  A vertical declares an unconditional gate in its manifest (`guards: [{ before, predicate, config }]`); a module contributes the named predicate (`predicates` on `ModuleRegistration`, typed `GuardPredicate`); the kernel evaluates it inside the guarded operation's own transaction, before the handler, failing closed. `withdraws` lets a vertical suppress an engine's default operation binding so the guarded wrapper is the only door — without it a gate is reviewable but bypassable. Both are optional and additive: existing manifests parse and behave unchanged.

  The protocol engine gains a `protocol/all-signed` predicate and the `requireCountersigned` in-scope function; the work-order engine exports `closeWorkOrder` as an in-scope function (its `workorder/close` operation is now the thin binding). The scope-host contract suite covers guards and withdrawal, so every adapter must implement both.

## 0.1.0

### Minor Changes

- 7583dab: First end-to-end feature set: the kernel deltas that carry a running vertical.

  - **Contracts**: relationship tuples with proof-path `Decision`s (an unexplained allow is
    unrepresentable), entity-narrowed capability grants, `entityRelations` and `ui`
    contributions on the module manifest, shared `money` schema with exact decimal
    arithmetic, attachment `visibility` classification.
  - **Kernel**: `registerModule` (manifest + migrations + operations + consumers),
    `OperationContext.link`, entity-aware `PermissionChecker`, `HostAdmin` surface for
    roles/assignments/grants/membership, `assertAllowed`/`PermissionDenied`.
  - **adapter-sqlite**: built-in constrained tuple permission engine (fixed four-rule
    algebra, proof paths, grant expiry, org membership), per-scope migration journal
    (lazy on wake, crash-safe), per-operation transactions (writes and emitted events
    commit or roll back together), local at-least-once event dispatch with a kernel
    delivery journal and system-actor consumer contexts.
  - **contract-tests**: atomicity, migration-journal, dispatch exactly-once, and tuple
    permission suites — every adapter must pass all of them unchanged.
  - **Engines**: first releases of `@substrat-run/engine-workorder` (state machine, append-only
    time/material, fat completion events) and `@substrat-run/engine-invoicing` (event-consuming
    snapshot fakturaunderlag with provenance, immutable once exported).
