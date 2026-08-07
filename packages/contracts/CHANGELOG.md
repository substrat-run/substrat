# @substrat-run/contracts

## 0.51.0

## 0.50.0

### Minor Changes

- fa85dd8: feat(lifecycle): a reap leaves a recoverable copy behind (#493)

  `reapScope` is the one lifecycle step with no undo — it frees a scope's Durable Object
  storage, which Cloudflare never garbage-collects on its own — and the copy that made it
  survivable was the operator's job to remember, from a different surface. It is now a
  property of the route: `POST …/scopes/:s/reap` writes a **full-fidelity dump** to a
  platform-held backup store _before any byte is wiped_, and records its address on the
  reap's admin-log entry. A store that throws aborts the reap with the scope intact,
  answered as a `502` that says the data is untouched rather than a bare 500.

  A **dump, not a snapshot fork**, deliberately: `orchestratedSnapshot` provisions the fork
  inside the vertical's own deployment and activates it, so a fork's bytes live in the very
  deployment a retirement is about to delete, and it counts as a live scope in
  `countScopesForVertical` — re-blocking the `deleteVertical` the reap was clearing. A dump
  leaves the deployment, and `POST …/restore` already loads one back.

  Full fidelity, never masked. `GET …/export` masks by default because it hands bytes to a
  _caller_; a backup goes platform→platform and is never handed out, and a masked dump
  restores a structurally-valid but factually wrong scope.

  New seam `ScopeBackupStore` (host-injected, provider-neutral like `ObservabilityReader`)
  with `createR2BackupStore` for Cloudflare R2, plus `GET/POST …/scopes/:s/backups` and
  `GET …/scopes/:s/backups/:capturedAt`. `reapScope`'s options gain `backupRef`, carried
  into the audit entry (`after.backupRef`, explicitly `null` when no copy was taken).
  `ScopeBackup` joins `scopeDump` in contracts.

  Defaults are per-act, not global: a **scope** reap backs up unless told otherwise, while a
  **tenant** reap (§4.8, partly an Art. 17 erasure path) takes no copy unless staff ask —
  silently writing an erased customer's data to a bucket would defeat the request. Asking
  for a backup where no store is configured is refused `501`, never silently skipped, so a
  control plane deployed with the bucket unbound fails loudly; a caller that does not ask
  still reaps unbacked where no store exists (self-host, embedded). Jurisdiction-pinned
  scopes are refused until a per-jurisdiction store exists (K-32) — the reap must not wipe
  what the platform may not legally copy.

- 5063d1c: feat(platform): the directory backs itself up, and the restore is rehearsed (#40)

  Every database the platform holds was protected except the one whose loss is
  unrecoverable. A scope has ~30-day Durable Object point-in-time recovery — continuous,
  per-scope, and strictly better than any daily copy, which is why scheduled per-scope
  backups are deliberately _not_ built here. The **directory** is the case PITR cannot
  answer: it is a single DO, so a bug that deletes it outright leaves nothing to rewind, and
  no scope knows its own tenancy, hostname or bound version well enough to rebuild the map
  from below. `control-plane.md` had already named the stake — _losing it is losing the
  platform, not losing a cache_ — without resolving it.

  New pair on `HostAdmin`, implemented by **both** adapters: `exportDirectory` (a
  full-fidelity row-dump of tenants, scopes, hostnames, verticals, entitlements, identities
  _and the audit spine_ — a directory restored without its history cannot say what the
  platform did before the restore) and `restoreDirectory`. The export is audited in the K-24
  access log with no tenant, because its subject is every tenant at once; the restore is a
  new `restoreDirectory` admin action, written _after_ the replace so the entry survives it
  — the first row after a restored history is the restore.

  `DirectoryBackupStore` is a sibling seam to `ScopeBackupStore` rather than a widening of
  it: a scope copy is taken at a moment and addressed by its scope, a directory copy is taken
  on a schedule and pruned to a window. `createR2DirectoryBackupStore` keys under
  `directory/`, so it can share the scope bucket or have its own. Bound as
  `DIRECTORY_BACKUPS` on the control-plane worker.

  `backupDirectoryIfDue` runs **last** in the platform sweep, after the phases that mutate
  the directory, so a copy is of a settled directory. The cadence is enforced by reading the
  newest stored copy rather than by a second trigger: the quarter-hourly cron takes **one
  copy a day**, a missed tick is caught up on the next pass (late, never never), and the
  schedule needs no durable state of its own. **Retention is 30**, matching the PITR horizon
  so the two defences expire together — and pruned only _after_ a successful capture, so a
  failed backup can never be the thing that deletes the last good copy.

  Routes (staff-only, none per-tenant): `GET/POST /directory/backups`,
  `GET /directory/backups/:capturedAt`, `POST /directory/restore`. All four answer `501`
  where no store is bound rather than an empty list — "nothing held" and "nobody is looking"
  must not read alike. A restore **replaces**, so it refuses a directory that still holds
  tenants unless the body says `overwrite: true`: the dangerous case is not a slip of the
  fingers but a replayed restore against a control plane that already recovered.

  `#40` asked for a _rehearsed_ restore, so the round trip runs in the contract suite against
  both adapters — capture, diverge, restore, then open a scope and invoke through the
  directory it just rewrote. `control-plane.md` §4.9 records RPO ≤ 24h / RTO ≤ 1h, the
  runbook, and the honest limit: the bucket lives in the platform's own Cloudflare account,
  so this survives losing the _directory_, not losing the _account_. The seam is
  provider-neutral so an off-account target is a drop-in when that is worth paying for.

- d7d8fa9: feat(control-plane): export a whole tenant — Art. 20 portability, and the escrow handover (#36)

  `GET /tenants/:t/export` returns one tenant, whole, in one file: the tenant record, its
  scopes, orgs and memberships, roles, entitlements, identity links, hostnames, the store
  ledger, connections — and each scope's database.

  **Composed only from the sanctioned reads** (`listScopes`, `listOrgs`, `listMembers`,
  `listRoles`, `listEntitlements`, `listIdentityLinks`, `listHostnames`, the store ledgers,
  `listConnections`, `exportScope`), which is a constraint rather than an implementation
  note: control-plane.md §7 says the control plane must not acquire a back door into scope
  databases, and an export that reached past the audited surface would _be_ that back door.
  Because every part is already K-24 access-logged, so is the whole. No adapter changes —
  both adapters get it because they already implement the seam.

  **A different shape from #40's directory dump, deliberately.** That one is raw tables for
  _recovery_: complete, replayable, unreadable to a customer. This one is one tenant's slice
  in the platform's own documented vocabulary, so the receiving party can read it without
  knowing our schema. Only the per-scope `data` is raw, because that half has to be loadable
  — and the round trip (export → `importScope` → same tables, same row counts) is a test
  rather than a claim, which is #36's own acceptance criterion.

  Four rules, each of them a way of not lying about what the file is:

  - **Masked by default; `?full=true` is the break-glass** — the same posture as `scope
pull`, with one heuristic sweeping _both_ halves. Driving this surfaced a real gap: an
    identity link's `externalId` is usually the person's email, and the shared PII heuristic
    did not match it. `external_id` is now in the column list, which also masks opaque
    third-party ids in a masked pull — the lossy direction of a trade that costs fidelity
    nothing and a leak everything.
  - **Tombstones are exported; their data is not.** An archived or reaped scope's record is
    part of the tenant's history; a reaped scope has no storage left, so nothing in `data`
    claims to be its data.
  - **Stores are inventoried, not contained** — per-tenant D1/R2 stores appear as a ledger.
    Their bytes are not in the file, and an export that omitted them would read as complete.
  - **The admin log is `full`-only** — it records what _staff_ did, so it is not Art. 20
    material, but it is what an escrow or a dispute needs.

  **Jurisdiction refuses as a unit**: one pinned scope taints the file (K-7/K-32), so the
  route refuses rather than exporting the global scopes and quietly omitting the rest.

  New `tenantExport` contract, composed from the existing schemas rather than restating
  them. `maskRecords` joins `maskDump` so object-shaped records get the same sweep as
  table-shaped ones.

  Not in this change: retention. The admin log is append-only with no sweeper and the backup
  buckets have no lifecycle rule — deleting from an audit log §4.4 says is kept whole is a
  policy decision, tracked rather than assumed.

## 0.49.0

### Minor Changes

- a13c8fb: feat(ci): generate the deploy workflow, and name an immutable per-build preview URL (#509)

  The CI recipe is now a generator rather than prose. `deployWorkflowYaml` moves into
  `@substrat-run/contracts`, and the new `substrat init --ci github` writes the same
  `.github/workflows/substrat-deploy.yml` the dashboard's one-click setup commits — for the
  builder who owns their own CI, or who wants the release-train shape (`--release changesets`:
  only a `package.json` version move releases; ordinary merges just move the test env).

  Why generate it: the workflow encodes a version-label discipline that is load-bearing and
  undiscoverable from `--help`, and the hand-written one got it wrong — it pushed
  `--version 0.1.<run number>` on every run, claiming a real registry patch coordinate each time
  and punching holes in the version sequence. Generated runs now use the registry bump for a
  trunk release, the repo's own version for a changesets release, and a semver **prerelease**
  label for everything else, which `nextVersion`'s anchored parse skips.

  The PR sticky comment now names **two** URLs: the sticky `--pr-<n>` preview, which is rebound
  on every push, and — when the repo opts in with the `SUBSTRAT_PER_BUILD_PREVIEW` variable — an
  immutable `--pr-<n>-<run>` URL frozen to exactly that build. A moving pointer is only safe when
  every build is also addressable, so "the bug on the PR preview" can always de-reference to a
  fixed artifact. The comment bodies are rendered from one module for both writers, so the
  CI-written and platform-written comments are byte-identical rather than merely similar.
  `SUBSTRAT_TEST_SCOPE_ID` likewise makes every merge rebind a long-lived test environment,
  keeping "tracks main" a CI step rather than a platform noun.

- f11a961: feat(deploy): native static assets for dispatched verticals (#340)

  A vertical can now declare `runtimeNeeds.assets` — a directory of built files plus how the
  runtime should route paths against it — and the platform uploads those files to Cloudflare's
  own asset store through the three-step `assets-upload-session`. They are served from the edge
  without invoking the worker, and versioned atomically with the code.

  This replaces inlining the whole SPA into the worker bundle as base64, a workaround justified
  by "WfP dispatch has no static-assets path" that has been stale since Workers for Platforms
  grew that endpoint. The cost it removes is concrete: ~+33 % encoding overhead counted against
  the script-size limit (Meridian's and Manyfold's inlined SPAs are ~3.9 MB of generated source
  each), the whole UI re-parsed on every cold start, and a worker invocation for every image.

  Assets are **not a binding** — they are a top-level upload path — so they can neither be
  allowed nor refused by the §4 binding allowlist. D-44 records the separate decision: the bytes
  are admitted because they carry no reach (inert, public, no code and no credential), while
  their **content-address is verified** — the asset store dedups by hash across the whole
  dispatch namespace, so the control plane re-derives every hash from the received bytes and
  refuses a mismatch rather than letting one push decide what another vertical's identical-hash
  asset serves. An `assets.binding` (programmatic `env.ASSETS`) is refused at push time rather
  than dropped silently, since a worker shipped with an undefined `env.ASSETS` looks deployed
  and 500s on first request.

  The file manifest is retained with the rest of the deploy manifest, which is what lets a
  **promote** re-attach a version's assets onto the stable serving script from content addresses
  alone — the archive script gives back the modules (#286), dedup gives back the assets. A
  re-serve that finds the runtime has dropped bytes it cannot supply refuses and says to push
  again, instead of serving a half-broken page.

  The dashboard gains a per-version Assets panel (path, type, size, content hash) over the
  manifest it already persisted.

## 0.48.1

## 0.48.0

### Minor Changes

- 791e4fd: Retire the `dev`/`staging` channels — a vertical has exactly ONE channel now (#509, #515,
  Tier 4). `channelName` narrows to `z.enum(['prod'])`: `prod` is the serving pointer, and the
  old `dev`/`staging` pointers were write-only (nothing ever served or read them, #509 §2). A
  non-prod environment is a _scope with data_ — a preview (`substrat preview create`) — not a
  second pointer at the same code.

  `prod` stays the wire name, so `--promote prod`, generated CI, and existing `channel_history`
  rows keep working unchanged — this is a narrowing, not a rename.

  - **Promote/history routes** refuse a non-prod channel with a `400` pointing at previews
    (`substrat preview create --tag <tag>`), instead of silently accepting a dead pointer.
  - **`listChannels`** filters to the serving channel in both adapters, so an inert `dev`/`staging`
    row a pre-retirement push may have left never reaches the now-`prod`-only parse. `channel_history`
    is untouched (audit + the PITR anchor `at`).
  - **CLI**: `substrat promote` no longer needs `--channel` (it defaults to `prod`); `--promote`
    documents `prod` only.
  - **Console (dashboard + control-plane)**: channel types, pills, and the promote picker narrow
    to `prod` — the dead dev/staging buttons were already removed in #512.

  The two human checkpoints are unchanged: the `--ack-permissions`/`--ack-migrations` gate still
  fires on the `prod` promote (the digest-change consent), and the fork-before-promote snapshot
  still runs at the bind. No migration is required — legacy dev/staging rows become inert data the
  readers now skip.

## 0.47.0

### Minor Changes

- a90dec0: Preview lifecycle fixes — the three self-contained repairs from #509 (issue #512, Tier 1),
  turning previews into something you can actually run a workflow on. No design change to the
  channel model; that stays for #515.

  - **(a) A reused preview no longer silently dies.** `orchestratedPreview`'s reuse branch
    rebound the new version but never touched `expiresAt`, so a `--tag dev` preview CI keeps
    re-pushing to was reaped 72h after its _first_ creation regardless of activity. The GC
    deadline is now recomputed on every create — reuse included — via a new narrow
    `HostAdmin.setScopeExpiresAt` (mirroring `setScopeServingRef`; audited on both adapters).
    And `ttlHours` accepts an explicit **`null` = pinned until deliberately deleted**, so a
    long-lived preview environment is expressible at last. `substrat preview create --ttl none`
    pins; re-running a tag renews its TTL.

  - **(e) `preview create` stops claiming registry coordinates.** It auto-bumped via
    `nextVersion`, so every PR preview burned a real patch number — the disease that left holes
    in the registry. Previews now push a semver **prerelease** label (`<base>-<tag>.<n>`) via the
    new `previewVersion`: legible (it names the release it rehearses) yet free — `parseSemver` is
    anchored `^\d+\.\d+\.\d+$`, so a prerelease can neither collide with nor advance the coordinate
    the repo owns. An explicit `--version` still wins.

  - **(f) The console stops offering promote buttons that do nothing.** `dev`/`staging` are
    write-only (no reader consults them — #509 §2), so the Verticals view now offers only `prod`
    (self-serve for a private vertical, staff-gated for a listed one) and renders no dead channel
    buttons. Read-only history/pills are untouched.

- 3fcf34b: Give hosted verticals a sanctioned way to send transactional mail — the resolution of the
  outbound-policy open question (#303). The sandbox deliberately keeps `send_email` off the §4
  allowlist (and a Workers-for-Platforms dispatch script cannot bind it anyway), so a vertical
  never sends directly: it POSTs to the control plane's new `POST /internal/email/send` **relay**,
  which sends on its behalf — but only if that vertical holds the staff-granted `emailSender`
  capability. The `from` address is always the platform's onboarded sender.

  The capability mirrors `tenantProvisioner` exactly, as three parts:

  - a manifest **request** — `package.json` `substrat.sendsEmail`, carried on push into the
    registry as `sendsEmail`, refreshed on every push and granting nothing by itself;
  - a registry **grant** — `emailSender`, a directory flag a push can never set or keep, flipped
    by the new staff op `setVerticalEmailSender` (and the console's "Grant email sender" toggle);
  - a platform-held **relay** — `PlatformRelayEmailTransport` (another `EmailTransport`
    implementation) on the vertical side, and the control-plane endpoint on the other, which
    re-derives _which_ vertical is calling from the named `(tenant, scope)` and checks the grant
    against that. Holding the shared `PLATFORM_SECRET` (injected into every dispatch script, and
    the relay's auth) is not enough. The control plane's own origin is injected into every vertical
    as `CONTROL_PLANE_URL` so it knows where to POST.

  `HostAdmin` gains `setVerticalEmailSender`; both adapters persist a nullable `email_sender`
  directory column (a directory schema change, not a module migration). The auth-server demo
  declares `sendsEmail` and uses the relay transport when hosted, so its Better-Auth
  `sendResetPassword` flow finally delivers on a dispatch install. Everything is additive — every
  existing manifest, registry row, and `HostAdmin` call site keeps compiling.

## 0.46.0

## 0.45.0

### Minor Changes

- 846af24: Record tenant **provenance** so the fleet can tell an app-provisioned customer tenant
  from a first-class one. `Tenant` gains `provisionedByTenant: TenantId | null` — a FK to
  the manager's tenant, set only when a manager vertical creates the tenant via the
  `provision-tenant` platform intent (#412), and null for a direct staff create.

  The value is host-derived, never caller-supplied: `provisionTenantHandler` stamps
  `ctx.tenantId` (the manager tenant the host resolved from the provisioning scope's
  directory row — the vertical can't forge it), and the direct `POST /tenants` route forces
  it null. `createTenantInput` gains the field as **optional** (drain supplies it; staff
  create omits it), so the `HostAdmin.createTenant` signature is unchanged and every
  existing call site keeps compiling. Both adapters persist a nullable
  `provisioned_by_tenant` column (a directory schema change, not a module migration).

  This unblocks the #412 invariant-2 entitlement-ownership bound (a listed manager may only
  `set-entitlements` on tenants it provisioned) — this change records the ownership fact;
  enabling that enforcement is a separate follow-up.

## 0.44.0

## 0.43.0

## 0.42.0

## 0.41.0

### Minor Changes

- d222905: Platform blob store + attachment surface (#473): `attachmentTargets`, declared by
  the contract and every engine but implemented by nothing, now has a runtime home.

  - **A fourth store shape.** `blobStoreNeed` in `runtimeNeeds.blobStores` — the
    `tenantStoreNeed` sibling for attachment bytes: the platform mints one bucket per
    tenant (R2 on `adapter-cloudflare`, a per-tenant directory on the pure adapter), the
    builder declares no id, so it is a _need_ the platform provisions, never an `r2_bucket`
    binding the bundle carries. Seams: `ScopeHost.provisionBlobStore` / `listBlobStores`,
    a `blob_stores` ledger in both adapters, and the `createR2BlobStores` REST client.
  - **`attachmentTargets` consumed.** `ScopeHost.attachments(principal, tenant, scope)`
    gates every read by the declared target's `readPermission` and every mutation by its
    new optional `writePermission` (default: the read key) — proof path included,
    per-entity, evaluated where `ctx.check` is. The read gate no longer leaves `ctx` for a
    hand-rolled route handler.
  - **Rows in the scope, bytes in the store.** The metadata fact lands in a new
    `_substrat_attachments` table inside the scope database (so `scope pull` / restore /
    PITR carry it), transactional with an `attachment.added` / `attachment.removed` spine
    event. Bytes go straight to the per-tenant store, never through the scope's
    structured-clone invoke pipe. Keys are platform-derived (`scope/<scopeId>/att/<id>`),
    so per-scope isolation inside a per-tenant store is construction, not convention.
  - **Integrity across the split.** Bytes are SHA-256'd at upload and written once under a
    fresh ULID key, so a row can never point at bytes other than the ones it was born with;
    a PITR rewind can at worst orphan an object (GC-able), never re-point a row.
  - **Deploy path.** The WfP bindings patcher and every in-place serving upload now
    re-derive `r2_bucket` bindings from the blob-store ledger alongside the D1 tenant-store
    bindings (`blobStoreBindingName(binding, tenantId)`), so a re-deploy is structurally
    unable to drop a tenant's attachment bucket. The CLI carries `blobStores` from
    `runtimeNeeds` into the deploy manifest, admitted as a need (never a binding).

## 0.40.0

### Minor Changes

- 3c77f64: Connections become multi-account per provider — the Vercel "Git namespace" shape. Live-uniqueness widens from (tenant, vertical, provider) to (tenant, vertical, provider, account), where the account leg is `COALESCE(external_account_ref, '')`, so providers that never set an account ref keep their singleton semantics while a tenant can now hold one GitHub connection per org/user. `openConnection` gains an optional `externalAccountRef` selector (omitted with several accounts live it throws rather than picking one arbitrarily), `connectionFilter` gains `externalAccountRef`, and both adapters migrate the old `_substrat_connections_live` index in place (`DROP INDEX IF EXISTS` + the new `_substrat_connections_live_account`). The dashboard's git-import flow connects additional GitHub accounts without severing the first, lists repos per selected namespace, and threads the account through branches + one-click CI setup.
- d59a515: Every list read pages the same way: the admin-log cursor convention, generalized.
  `@substrat-run/contracts` gains `pagination.ts` (`listPageQuery` — limit default 20,
  max 200 — `ListPage`, `Page<T>`, `pageOf`); every `HostAdmin.list*` takes an optional
  keyset page (unset stays unbounded for in-process callers); both adapters implement
  the keyset SQL and the contract suite proves it. **Wire change:** every control-plane
  GET list route (`/tenants`, `/scopes`, `/verticals`, `/verticals/:slug/versions`,
  `/channels`, `/channels/:channel/history`, `/hostnames`, `/roles`, `/admin-log`) now
  returns `{ entries, nextCursor }` and defaults a 20-row page — older CLI versions
  parse these as bare arrays and must upgrade; this CLI walks the cursor wherever it
  needs the complete list.

## 0.39.0

### Minor Changes

- 3cf4e3b: The provisioner capability gains its request half (#455): a manager vertical DECLARES the
  target verticals it provisions — package.json `substrat.provisions`, carried on push to
  the registry row (`vertical.provisions`, riding the refreshable install*spec bag) — and
  the console reviews the declaration like a publish request (declared-but-ungranted shows
  as \_provisioner requested*; the grant button reads _Approve provisioner_). Declaration is
  a request, never a grant: `tenantProvisioner` stays the staff-flipped flag a push cannot
  touch (contract-tested both ways). The drain's `admitManager` now distinguishes
  _undeclared_ (fix your manifest) from _declared-but-ungranted_ (awaiting staff) in its
  refusal, and — #412 invariant 4 — bounds a granted manager's `provision-tenant` to its
  declared targets, phased: a granted manager that declares nothing keeps its pre-#455
  unbounded behavior until its next push declares.

## 0.38.0

### Minor Changes

- 5afb162: The tenant-provisioner capability becomes a directory-backed staff grant (#444, #412).
  `vertical.tenantProvisioner` is a registry flag flipped by the new audited
  `setVerticalTenantProvisioner` admin action (console: Grant/Revoke provisioner, route
  `POST /verticals/:slug/tenant-provisioner`, staff-only) and read by the drain's
  `admitManager` at execution time — replacing the `TENANT_PROVISIONERS` env list, which
  was configured nowhere and would have put customer slugs in deployment config. Never set
  at registration and never touched by a re-push refresh (contract-tested): pushing code is
  never how a vertical acquires or keeps platform authority. BREAKING for
  `control-plane-api` consumers: `ManagedTenantDeps.provisioners` is gone — the grant
  lives on the registry row.

## 0.37.1

## 0.37.0

## 0.36.1

## 0.36.0

## 0.35.0

### Minor Changes

- 17eec41: Platform intent handlers for the manager-vertical capability (#412): `provision-tenant`
  and `set-entitlements`. A manager vertical (a console whose job is to add tenants — the
  AuthHero console is the first consumer) enqueues via `ctx.requestPlatform`; the drain now
  executes both kinds with `HostAdmin` authority. `provision-tenant` creates a NEW customer
  tenant, grants its entitlements, and materializes its first scope running the PAYLOAD's
  vertical exactly as a first install would (serving-deployment resolution, per-tenant store
  mint (#301), `provisionInstance` with the #310 projection, config delivery, activate) —
  all ids are payload-proposed join keys, so an at-least-once drain converges.
  `set-entitlements` reconciles a managed tenant to a plan's target set — grant what's
  named, revoke declared-but-absent — and re-projects into the tenant's auth scope via the
  vertical's idempotent reconcile.

  Because a new tenant has no proving parent scope, admissibility is bounded on the
  MANAGER: a tenant-provisioner capability (the control plane's `TENANT_PROVISIONERS`
  deployment config while every manager is first-party) and the manager's registry-declared
  SKU universe, which bounds both grant and revoke. Contracts gain the wire schemas
  (`provisionTenantPayload`, `setEntitlementsPayload`, `entitlementSelection`, kind
  constants) matching the console's `intents.ts` verbatim.

## 0.34.0

### Minor Changes

- ab637f0: Per-tenant relational stores go live on Cloudflare (#301 PR-2). `provisionTenantStore`
  now mints a real D1 per (tenant, vertical, binding) (`createD1TenantStores`, on the
  platform credential), records it in the directory's `tenant_stores` ledger, and the
  provision endpoint hands the K-31 callback the declared handles automatically — the
  worker reaches its tenant's store through a real `d1` binding named
  `tenantStoreBindingName(binding, tenantId)` (new in contracts), attached at provision
  via the WfP settings PATCH (`createWfpBindingsPatcher`) and re-derived from the ledger
  on every in-place serving upload so a re-deploy can never drop it. `openTenantStore`
  on the Cloudflare host is the out-of-band D1 HTTP-query reach;
  `d1TenantRelationalStore` wraps the worker-side binding in the substrate store shape.
  Contract change: `TenantRelationalStore.query/exec` are now async — D1 has no sync
  path, and PR-1's sync shape was satisfiable only by SQLite. New read:
  `HostAdmin.listTenantStores` (both adapters).

## 0.33.0

### Minor Changes

- 6d3429e: Identity links ride the scope-local projection (#406): the control plane stays the
  audited source of truth (`linkIdentity`/`unlinkIdentity`), and every identity write now
  fans out into the tenant's projected scopes (`_substrat_identity_links`), with CP-less
  delivery on the provision/reconcile channel entitlements already use. New surfaces:
  `HostAdmin.listIdentityLinks` (the audited per-tenant gather), the
  `projectedIdentityLink` contract shape, `identityLinks` on provision/reconcile payloads,
  and `CloudflareScopeHost.resolveIdentityLocal` — the CP-less auth adapter's
  `(provider, externalId) → principal` read against the scope's own storage, replacing
  login maps compiled into the bundle (offboarding by deploy; revocation undone by version
  rollback).

## 0.32.0

### Minor Changes

- 99af6b6: Add `resolveScopedEnvSpec` — read a hosted instance's delivered per-scope config overlaid on its envSpec defaults

  A hosted vertical's per-install settings (saved in the dashboard Env tab, delivered via
  `/internal/configure`) land in the scope's own storage, not in worker bindings. Env-spec
  `default:` values ride as worker bindings shared by every install of one serving script, so
  `resolveEnvSpec(env)` can only ever return the deployment-wide default — a vertical that reads
  it silently ignores a saved per-install override.

  `resolveScopedEnvSpec(spec, raw, delivered)` is the pure merge that fixes that: precedence
  **delivered > env > default**, declared keys only (the manifest stays the allow-list), an empty
  delivered value is not an override, and `missingRequired` is recomputed over the overlaid values.
  It stays dependency-free; each vertical supplies `delivered` from its own per-scope store.
  `resolveEnvSpec` is documented as deployment/defaults-only, and auth-server's `effectiveCfg` now
  uses the shared helper instead of a hand-rolled overlay.

- 070f4dc: A vertical can schedule its own recurring work (#383)

  A vertical can now declare `schedules` in its module manifest — operations the platform
  invokes on every live scope of it, on a cadence, driven by the existing platform sweep. It
  is the seam a domain rule triggered by the passage of time (a contract that activates on its
  start date, a leave that can no longer be approved once it has already begun) had no way to
  reach: the operation was written, idempotent, and paged, but nothing woke it up on a date.

  The work is attributed honestly. Rather than the out-of-band workaround of signing in as a
  human and running under their permission — the attribution laundering #97 refused — a
  schedule runs under a **system principal**, the third caller #97 named, built the same way it
  built the connector seam:

  - a new `{ kind: 'system', id: ModuleId }` check-subject, mirror of the connection subject;
  - `ScopeHost.getSystemScope(moduleId, tenantId, scopeId)` — a door whose stub stamps
    `{ system: moduleId }` on events and resolves `system:<moduleId>` grants;
  - `HostAdmin.grantToSystem(...)` — the scheduler analogue of `grantToConnection`, projected
    from a schedule's declared `permissions` at provisioning, so `ctx.check` stays the single
    gate and the grant appears in the reviewed permission diff. Revoking it disables the
    schedule for one tenant, no special flag.

  `runPlatformSweep` gains a schedules phase (`registeredSchedules` / `runDueSchedules`) that
  enumerates each vertical's live scopes and fires due operations under bounded concurrency,
  skipping forks and any scope that does not hold the grant, recording per-scope outcomes in
  `PlatformSweepReport.schedules`. All additive: a manifest that declares no schedules, and a
  host predating the seam, behave exactly as before.

## 0.31.0

### Minor Changes

- fbf0704: Multi-scope Manyfold: archive a site.

  Rounds out scope management (create + switch were already there) with **archive**, reusing the
  platform-intent mechanism — archiving a scope is a platform action the sandbox-clean vertical can't
  do itself, so it's another intent kind:

  - **contracts:** `archive-scope` kind + `archiveScopePayload` (`{ scopeId }`).
  - **control-plane-api:** `archiveScopeHandler` — the drained scope proves the tenant; the target
    must be under that same tenant and run the same vertical (verified against the directory), then
    `host.admin.archiveScope`. Idempotent (an already-archived/absent target is a no-op success).
  - **control-plane worker:** registers `archive-scope` alongside `provision-sibling` in the drain.
  - **vertical-auth:** `IdentityDO.forgetSite` drops a site from the per-tenant registry.
  - **Manyfold:** a `manyfold/archive-site` op (`content:manage-sites` — no new permission) enqueues
    the intent; `POST /api/sites/:slug/archive` runs it as the caller, then optimistically drops the
    site from the registry so the switcher updates immediately.
  - **Manyfold app:** an admin-only **Archive** control next to the switcher (shown only when the
    tenant has more than one site); it archives the current site and switches away.

  Tested: the handler archives its target + is idempotent + refuses a cross-vertical target;
  `forgetSite` drops a site; the `archive-site` op enqueues an `archive-scope` intent and an author is
  denied. Refs #358.

- 41d01f6: Platform intents, Phase B2: the drain engine + `provision-sibling` handler.

  The platform-side execution for `docs/design/platform-intents.md`. Because a scope's intent rows
  live in the vertical's own deployment (K-31), the platform PULLS them over the vertical's
  `/internal` surface: `VerticalClient` gains `listPlatformRequests` / `settlePlatformRequest`
  (the B1 read/settle surface, now reachable cross-deployment).

  - `drainScopePlatformRequests(client, ctx, handlers)` lists a scope's pending intents, dispatches
    each to the handler registered for its `kind`, and settles the outcome — an unknown kind settles
    `failed` (never a silent drop), a thrown handler settles `pending` (retried next drain).
  - `provisionSiblingScope(...)` extracts the exact sequence M1's `POST /tenants/:tenantId/scopes`
    route runs (inherit parent vertical/jurisdiction → provision → materialize → activate) into one
    reusable home; the route now calls it. `provisionSiblingHandler` wraps it as the
    `provision-sibling` intent handler, with two-phase idempotency (a scope id minted on an earlier
    pass is reused, so a retry targets the same sibling).
  - `contracts` gains the shared `provisionSiblingPayload` (`{ slug, name, owner }`) + the
    `provision-sibling` kind constant.

  Tested with a fake vertical transport (dispatch → settle: done / unknown-kind-failed /
  thrown-pending) and against a real SQLite host (the handler provisions + activates a sibling under
  the parent tenant, seating the owner). The triggers — the periodic sweep phase and the router kick,
  plus each vertical's `/internal/platform-requests` endpoints — are Phase C. Refs #358.

## 0.30.0

### Minor Changes

- a698959: Derive the permission registry from a typed source, and require it in the deploy manifest (D-41).

  D-39 shipped the declared permission surface in the deploy manifest but left three seams as
  convention and introduced a machine-only generated file in git. The surface was discovered by a
  by-name `MODULES`/`ROLES`/`ENTITY_GRANTS` re-export from each vertical's `seed.ts` (wrong name,
  wrong file, or a vertical outside `demos/`/`apps/` vanished from the checkpoint with no error);
  `push` read a checked-in `permissions.json` and treated its absence as a silent empty surface; and
  `deployManifest.registry` was optional, so a push could carry no declared surface at all.

  Now the surface is declared once via a typed `definePermissions({ modules, roles, entityGrants })`
  in `@substrat-run/contracts` — a compile-checked single source. The checkpoint tool discovers it
  from a declared `package.json` `substrat.permissions` pointer rather than a `seed.ts` re-export
  (a package with a `seed.ts` but no pointer is now a hard error, not a silent skip), and emits only
  the human-readable `PERMISSIONS.md`. The machine-readable `permissions.json` is gone from git:
  `substrat push` derives the registry from the typed entry with the same new
  `buildPermissionRegistry`, bundling the entry with esbuild (deps left external, so a node-ful entry
  still resolves its own `node_modules`) and hashing the result into `digests.permission` — proven to
  reproduce the previously-committed files byte-for-byte, so the digest is unchanged.

  `deployManifest.registry` is now **required**: a push that declares no surface is rejected at the
  trust boundary and by the CLI before upload (absence is never a silent empty registry; a vertical
  that genuinely exposes nothing ships an explicit empty registry). A lenient `storedDeployManifest`
  (registry optional) is used only for re-reading manifests persisted before this change, so old
  versions stay readable and re-deployable in place. `@substrat-run/cli` gains an `esbuild`
  dependency.

- 67be7c7: Platform intents, Phase A: the `ctx.requestPlatform` primitive.

  Adds the foundation from `docs/design/platform-intents.md` — the sandbox-clean way a vertical
  asks the platform for a privileged action (provision a sibling scope, quota, …) without an
  upward call. A vertical operation calls `ctx.requestPlatform({ kind, payload })` after its own
  permission check; the kernel durably records a typed intent in this scope's new
  `_substrat_platform_requests` spine table (atomic with the operation, stamped with the actor), and
  returns the request id. The platform will pull and execute these with `HostAdmin` authority in a
  later phase — knowing the tenant inherently because it reads that scope's own DO.

  - `OperationContext` gains `requestPlatform(input): PlatformRequestId` (kernel), implemented
    symmetrically in both adapters; `contracts` gains `platformRequestId`, `platformRequestInput` /
    `platformRequest` schemas, and the `MAX_PENDING_PLATFORM_REQUESTS` backpressure bound (the verb
    refuses once a scope holds that many pending intents).
  - **Migration checkpoint:** a new `_substrat_platform_requests` spine table is added to each
    adapter's `KERNEL_DDL` (`CREATE TABLE IF NOT EXISTS`, so it back-fills existing scopes on next
    open). No versioned module migration; it is kernel spine, flagged `system` automatically.
  - Contract-suite coverage (both adapters): the intent is enqueued as `pending` with its kind /
    payload / actor, and rolls back with its operation when the handler throws (K-4).

  No consumer yet — the drain-executor, router kick, and the Manyfold "New site" flow are later
  phases (#358).

## 0.29.0

## 0.28.0

## 0.27.0

### Minor Changes

- 6901c16: Per-tenant relational stores as a first-class store type (#301, PR-1).

  A hosted vertical whose data model is one SQL database **per tenant** (a latency-sensitive
  multi-tenant auth/OIDC provider is the motivating case) can now declare a per-tenant
  relational store the platform provisions and hands over — distinct from a single shared D1
  (one database for every tenant) and from an own DO (one per scope). Because the platform
  mints the database per tenant and injects the id, the builder supplies **no `database_id`**:
  that is what closes the ownership gap a bundle-chosen id left open (self-serve-deploy.md §4).

  - **Vocabulary** — `tenantStoreNeed` in `runtimeNeeds.tenantStores` and a platform-minted
    `tenantStoreHandle` (`@substrat-run/contracts`). A per-tenant store is a _need_ the platform
    provisions, never a `declaredBinding`, so it never rides the §4 sandbox allowlist. The CLI
    carries `tenantStores` into the deploy manifest without emitting a static wrangler binding.
  - **The seam** — `provisionTenantStore` (platform mints, records in the directory, returns an
    opaque handle; idempotent) and `openTenantStore` (the vertical opens what it was handed and
    runs its own migrations) on `ScopeHost`, plus `ProvisionInstanceInput.tenantStores` so the
    K-31 pull-provision callback hands the handle over inside its fail-closed/idempotent/retry
    ready-gate. The handle's `ref` is opaque — a D1 `database_id` on Cloudflare, a per-tenant
    `.sqlite` file on the pure adapter.
  - **Pure adapter (real)** — `@substrat-run/adapter-sqlite` mints one separate `tstore__….sqlite`
    file per (tenant, vertical, binding), physically isolated from the scope DBs, backed by a
    new `tenant_stores` directory table (the idempotency + reap ledger). The whole path is
    exercised in dev/CI without Cloudflare.
  - **Cloudflare (stubbed)** — `@substrat-run/adapter-cloudflare` throws a clear `#301` marker
    from `provisionTenantStore`/`openTenantStore`; live D1 create/bind/HTTP-query is the tracked
    follow-up (PR-2), so nothing appears provisioned while its store does not exist.

  Additive and backward-compatible: `runtimeNeeds.tenantStores` and the manifest field default
  to empty, a `provisionTenantStore` audit action is a new enum value, and a vertical that
  predates `ProvisionInstanceInput.tenantStores` strips the unknown key.

## 0.26.0

### Minor Changes

- 2bdd22b: Custom-hostname issuance end-to-end + registrable-suffix (PSL) enforcement (#305).

  Binding a custom domain to a surface is no longer a bare `pending` row that a human flips
  to `active` by hand. The control plane now drives Cloudflare for SaaS through the real
  lifecycle — `pending → verifying → active | failed` — and enforces the registrable-suffix
  isolation D-35 has always specified but never checked in code.

  - **A `CustomHostnameProvisioner` seam** (`packages/control-plane-api/src/custom-hostnames.ts`)
    wraps the Cloudflare `custom_hostnames` API in pure web-standard `fetch`, injected into
    `createControlPlaneApi` exactly like the WfP uploader — so the transport holds no
    Cloudflare credential and the builder never holds one (D-34). Binding a **custom** domain
    calls `create` (→ `verifying`, storing the DNS records the tenant must publish); a
    **platform** mint under `PLATFORM_BASE_DOMAINS` rides the wildcard cert and goes straight
    to `active` with no per-hostname call.

  - **A scheduled reconcile pass** (`reconcilePendingHostnames`, wired into the control-plane
    worker's `scheduled()`) polls every `verifying` domain to `active`/`failed` and retries
    any stuck `pending` custom bind — issuance self-heals without a human. A new
    `POST /hostnames/:hostname/verify` route (and `substrat hostnames verify`, and the
    dashboard's _Check again_) re-polls on demand.

  - **New `@substrat-run/psl`** vendors the Public Suffix List + the canonical matching
    algorithm (no runtime fetch, web-standard only). `resolveCookieDomain` now rejects a
    cookie whose Domain is a public suffix (`co.uk`, `pages.dev`) — a real guard where the old
    label-count check waved multi-level suffixes through — and `bindHostname` refuses a custom
    domain that is a bare public suffix.

  - **Contract + storage.** `hostnameBinding` gains `customHostnameId` and `validationRecords`
    (additively, defaulting to null/[]), plus a `verifying` status and a `dnsRecord` shape. Both
    adapters get the two columns (additive ALTER), a `setHostnameIssuance` writer, and a
    `status` filter on `listHostnames` (index-backed) for the reconcile pass.

  - **The dashboard Domains view is wired to the live control plane** (`/api/domains`): list,
    add a custom domain (shows the DNS records to publish), _Check again_, and remove — no more
    mock rows. Removing a custom domain releases the Cloudflare custom hostname.

  Absent a SaaS zone (dev / self-host), a custom bind records `pending` and issuance simply
  does not run — existing behavior is unchanged until `CF_SAAS_ZONE_ID` is configured.

## 0.25.0

### Minor Changes

- e612b98: Reap archived scopes (§4.4): free the Durable Object storage that Cloudflare never
  garbage-collects. Deleting an app archives its scope — a tombstone-only transition that
  keeps the directory row but leaves the scope DO holding every byte forever. This adds a
  terminal `reaped` state past `archived`: `reapScope` wipes the DO's storage while keeping
  the directory row (audit history + burned slug), the one irreversible scope transition, so
  it only ever leaves `archived`, `getScope` fails closed on it, and its slug is released for
  reuse. Delivered two ways over one seam — the storage wipe reaches the vertical's own
  deployment (a hosted scope's DO is CP-less) via the same `deleteScope` dispatch the snapshot
  GC uses: a staff-only `POST /tenants/:t/scopes/:s/reap` (armed in the console behind a
  type-the-slug dialog, since there is no restore), and a `runPlatformSweep` phase that reaps
  scopes archived longer than `SCOPE_RETENTION_DAYS` — opt-in and unset by default, because
  the reap cannot be undone. Both adapters gain an additive `archived_at` column (stamped on
  archive, cleared on unarchive) to age the sweep, and their `(tenant_id, slug)` unique index
  becomes partial on the live statuses so a retained tombstone never blocks the slug reuse the
  pre-check already intends — closing a latent gap where archived slugs could not actually be
  reclaimed.
- caedb1c: A prod promote no longer strands a legacy scope's data, and the in-place serve is honest and
  complete end-to-end (#321). #287 shipped the serve-in-place, but existing (pre-#286) scopes were
  never migrated onto the stable serving script, so every promote re-stranded them: the private-
  vertical rebind cascade advanced a legacy scope's version to the incoming version's fresh,
  empty per-version dispatch script, `0001-init` re-ran against empty storage, and the app rendered
  a no-access page that read as an auth bug rather than data loss.

  - **Adopt-before-rebind on promote.** For a dispatch-backed vertical, the host rebind cascade is
    skipped (an embedded vertical, with no per-version script, keeps it) and the control-plane-api
    prod-promote handler owns adopt-then-rebind in the correct order: after a successful in-place
    serve, each still-legacy owned scope is adopted onto the stable serving script — its bytes moved
    off the per-version script _before_ any version pointer advances — then rebound. Retry-safe:
    nothing rebinds until the adopt succeeds, so a failed serve strands nothing and a re-promote
    resumes. A shared `adoptScopeOntoServing` primitive backs both this and the explicit endpoint.

  - **A builder-triggerable backfill for existing installs.** `substrat scope adopt-serving <scopeId>`
    migrates one legacy scope; `--vertical <slug>` (and `POST /verticals/:slug/adopt-serving`)
    backfills every still-legacy scope of a vertical. Idempotent.

  - **`scope restore` accepts an adapter-sqlite scope file and errors actionably.** `importDump`/
    `loadDump` re-assert the kernel spine after the drop-then-replay, so a dump that omits
    `_substrat_roles`/`_substrat_tenant_tuples` (an adapter-sqlite scope file keeps them in its
    directory db) no longer leaves the target missing spine tables and crashing a later check with a
    bare `no such table` → the detail-less `internal error` the field report hit. The restore route
    returns an actionable 422 instead of the generic 500.

  - **A failed in-place serve stops reading as "deployed."** `servingVersionId` is added to the
    channel surface (`VerticalChannel` + both adapters' `listChannels`): a prod promote moves the
    channel pointer before the serve, so when the serve fails `servingVersionId !== versionId` is the
    honest signal that the scopes still run the previous code. `substrat versions`, the dashboard
    deployments view, and the console surface the divergence and prompt a re-promote.

  - **An empty role projection is a platform condition, not only a per-app 403.** A new
    `GET /tenants/:t/scopes/:s/health` reports `roleProjectionEmpty` for an active scope whose served
    DO has zero projected roles (the silent state the field report chased through a migration-journal
    diff); the console Scopes detail raises it as a flagged condition.

  Prevents future stranding and gives a migration path for existing installs. Recovering data already
  stranded by an earlier bad promote (locating the specific prior per-version script) is a separate
  ops task, out of scope here.

- f0df69a: Tenant delete with a grace window (§4.8, #36): reclaim a deleted tenant's data instead of
  stranding it forever. `deleting` was a dead status — written once (a dashboard team-delete)
  and never consumed, so a tenant marked for deletion kept every byte. This finishes the
  lifecycle as the tenant analogue of §4.4's scope reap.

  `tenantStatus` gains a terminal `reaped` past `deleting`, and the `tenants` row gains a
  `deletingAt` timestamp (stamped on entering `deleting`, cleared on un-delete) so the grace
  window can be aged. `deleting` stays a reversible pause — every scope already fails `getScope`
  closed under a non-active tenant, so nothing is destroyed until a reap, and an un-delete (→
  `active`) restores the tenant whole. `reapTenant` (new on `HostAdmin`, directory-side only)
  clears the tenant's PII/config directory rows — identities and identity pools, membership
  tuples, roles, entitlements, orgs — and flips the row to a `reaped` tombstone, keeping the
  `tenants` row (burned slug + history) and `_substrat_admin_log` whole. It refuses any tenant
  not in `deleting`; `reaped` is unreachable via `setTenantStatus`.

  Delivered over one seam, two ways: a staff-only `POST /tenants/:t/reap` ("reap now", armed in
  the console behind a type-the-slug dialog, refused with 409 unless the tenant is `deleting`),
  and a `runPlatformSweep` phase that reaps tenants whose `deletingAt` is older than
  `TENANT_RETENTION_DAYS` — opt-in and unset by default, because the reap is irreversible. The
  per-scope byte-wipe runs above the kernel: the reaper archives-if-needed then reaps each scope
  through the existing `reapScopeFn` seam (so the control plane's orchestrated per-scope wipe
  applies for free), then clears the directory via `reapTenant`.

  Also settles #36's retention question: the admin log is the compliance witness (bokföringslagen
  §5.3) and is deliberately **never swept** — no TTL. The bound against dumping an ever-growing
  table lives on the read surface instead: `GET /admin-log` now defaults a page size (the
  in-process `auditLog` stays unbounded, so an internal caller that wants everything still gets it,
  and `nextCursor` walks the whole log).

  Full-tenant export (GDPR Art. 20 portability) is intentionally out of scope here — the per-scope
  `exportScope` seam it builds on already exists.

## 0.24.0

### Minor Changes

- 72b1128: Entitlements express a plan (#33): the two-column SKU flag grows `expiresAt`,
  `quota`, `plan` and `grantedAt`/`grantedBy`. Expiry is the one field the kernel
  itself enforces — an expired grant fails closed at the per-invoke gate exactly as
  if revoked, checked lazily at read like tuple expiry (never swept), and the row
  stays in `listEntitlements` so a lapsed trial reads as lapsed rather than
  never-granted. Quota and tier are expression only, per the D-33 reframe: they
  describe the builder's subscription, and counting usage against them is the
  builder portal's job — which is why plan _expression_ lands ahead of billing
  (#39 stays blocked on meters). Grant calls are PATCH-shaped: omitted fields
  preserve what the row carries (a bare re-grant on an idempotent provisioning
  path cannot silently turn a trial perpetual), explicit null clears, and any
  effective change is a renewal audited with before/after. `listEntitlements` now
  returns `EntitlementGrant[]` instead of `string[]`; the PUT route accepts the
  plan as an optional body (a bodyless PUT stays the bare-flag grant); both
  adapters widen `_substrat_entitlements` with nullable columns via the existing
  ensure-column path, so legacy rows read as perpetual boolean flags — exactly
  their old semantics. The console shows and edits the plan half; Callout's boot
  mirror forwards whole grants so the shared plane never sees a trial as
  perpetual.
- 1cfce31: A hosted vertical reads its entitlements at request time from a scope-local projection (#304),
  settling kernel open-question 5 with the same answer as the routing cache.

  Entitlements used to be a coordinator-only, trust-at-provision check: it gated _module loading_,
  but a dispatched worker could not read `plan`/`quota`/`tier` at request time — the `CONTROL_PLANE`
  binding is forbidden by the sandbox contract (#302) — and a CP-less scope short-circuited the gate
  to `true`, enforcing nothing in-request, not even expiry.

  Entitlements are now **projected into each scope** alongside roles and tenant tuples, extending the
  scope-local-permissions machinery rather than duplicating it:

  - **`OperationContext` gains `entitlement(key)` and `entitlements()`** — the sanctioned request-time
    read. Returns the live view (`key`, `plan`, `quota`, `expiresAt`) or `null`; expiry is applied at
    read, so a non-null result is always live. A hosted scope reads its local projection; a
    console-managed scope reads over the same RPC the permission checker uses. New `EntitlementView`
    contract type.
  - **The per-operation gate fails closed against the projection** on the scope-local path — expiry
    and revocation now enforce at request time in a hosted vertical, not only at provision.
  - **A grant/revoke fans out to invalidate** the projected scopes — the event-invalidation half of
    kernel open-question 5's answer (cached in scope DOs with event invalidation), deliberately the
    same project-on-write mechanism the routing/suspension cache defers to.

  Two posture calls, per #33's grain:

  - **Expose, don't enforce** `quota`/`plan`: the kernel gates presence + expiry; the vertical reads
    the number and enforces its own quota (no kernel usage-counting).
  - **Fail-closed enforcement flips per scope** via an `entitlements_enforced` marker set the first
    time entitlements are projected — a scope provisioned before #304 keeps trusting upstream until a
    fan-out / reconcile / re-provision back-fills it, so the switch to strict enforcement strands no
    live scope.

  `provisionScopeLocal` accepts an optional `entitlements` list (the platform passes the tenant's
  grants at provision). Scoped out as a follow-up: the platform→dispatched-vertical provision path
  (control-plane-api) does not yet _pass_ entitlements into `provisionScopeLocal`, so re-projection to
  a live dispatched worker rides re-provision/reconcile until that is wired; expiry still enforces
  locally meanwhile, because the projected row carries it.

- aa503c2: Record what authorized a mutation on its event, and what was refused (K-34, K-35).

  **K-34 — authorization on the event envelope.** `ctx.check` computes a `Decision` whose
  allow branch carries the proof chain, and the kernel discarded it — so a mutation-event
  recorded who acted but never under what authority. `DomainEvent` gains an optional,
  kernel-stamped `authorization: {permission, grant?}[]`: the checks the emitting operation
  passed, plus — when the allow came via a capability grant rather than a role — the granting
  tuple's `object` (the entity/node it was granted on). The shape correction from the design
  note: there is no grant _id_ — a grant is a relation tuple with no surrogate key, so the
  tuple's object is what names it; `contracts` exports `grantRefFromProof` for this. The full
  proof chain is not persisted (`explain` re-derives it); only the pointer re-derivation
  cannot recover — which check was consulted at write time — is kept. Module code can neither
  supply it (not on `DomainEventInput`) nor suppress it; system/override actors are
  unconditionally allowed, so their checks are not recorded. The operation context is now
  built fresh per invoke so the accumulator cannot leak across operations.

  **K-35 — a scope-local denial log.** `assertAllowed` threw `PermissionDenied` and nothing
  recorded it. A denial happens in the scope's serialization domain and rolls its own
  operation back, so it cannot reach the directory access log and would be erased if written
  in the operation's transaction. It now lands in a scope-local `_substrat_denials` (actor,
  permission, node, operation, at, drained_at), recorded at the operation boundary the moment
  a `PermissionDenied` unwinds it — a fresh autocommit write after the rollback, so it
  survives. Only enforced denials record; a bare `ctx.check` a module branches on is not a
  denial. `PermissionDenied` now carries the checked `permission` and `node`.

  Both surfaces are additive kernel-schema changes (a nullable `_substrat_outbox.authorization`
  column and the new `_substrat_denials` table), applied on both adapters (pure-SQLite and the
  DO port) via KERNEL_DDL + an additive column on existing scopes. Legacy outbox rows read as
  `authorization` NULL — honestly unrecorded, not empty. Held to the same contract on both
  adapters by new cases in the permission contract suite.

- 5a3ef82: Ship the vertical's declared permission surface in the deploy manifest (D-39).

  The permission registry — every key + description a registered manifest declares, the
  role templates provisioning defines, and the entity-grant shapes — existed only at build
  time as `demos/*/PERMISSIONS.md`. The deploy manifest carried `ownerGrants` and a
  `digests.permission` HASH of that surface, so the platform committed (at promotion) to
  content it did not hold, and the dashboard kept a hardcoded third copy. Worse, the digest
  was a placeholder: it hashed the worker's `bindings`, not any permission content, so the
  "permissions changed" promotion checkpoint fired on binding changes and missed real
  permission changes.

  Now `deployManifest` carries a first-class `registry` (`permissionRegistry`:
  `permissions[]` with `declaredBy`, `roles[]`, `entityGrants[]`), and `digests.permission`
  is its content hash. `tools/permission-diff.mts` emits a machine-readable
  `permissions.json` next to `PERMISSIONS.md` — from the SAME `MODULES` + `ROLES` +
  `ENTITY_GRANTS` the host registers — CI-checked with `--check`, so it cannot drift from
  what is enforced and it never requires the CLI to load (or execute) module code. `push`
  reads that checked-in artifact and injects it; the digest is a canonical, formatting-
  independent hash of the surface, so it moves iff a key, description, role, or grant shape
  moves. Additive and optional (D-28): a vertical shipping no registry hashes the empty
  surface (never bindings again), and the control-plane trust-boundary parse accepts the
  new field unchanged.

  This is what a tenant-facing permissions view (and a real version-to-version admission
  diff) consume without new backend plumbing.

- 4c275df: The hosted-vertical sandbox is a positive binding allowlist, not a denylist (#302).
  `assertSandboxContract` used to refuse a known-bad shortlist — `CONTROL_PLANE`, `service`
  bindings, cross-script DO — and allow **everything else by omission**: KV, Queues, R2, and
  analytics were never named or validated, and an unrecognized binding type sailed straight
  through. "What passes" was an emergent property of what the denylist forgot to ban, so a
  builder couldn't predict admission and the platform couldn't say what it permitted.

  Inverted: a vertical may now declare only its OWN resources, from one written set —
  `ADMISSIBLE_BINDING_TYPES` in `@substrat-run/contracts`, so the CLI can predict admission
  from the same list the control plane enforces. Permitted are its `durable_object_namespace`
  (own class only — no `script_name`, `class_name` ∈ declared `doClasses`) and own data stores:
  `d1`, `kv_namespace`, `queue`, `r2_bucket`, `analytics_engine`, plus inert `secret_text` /
  `plain_text` config. Anything else is refused **by omission**, with a message that names the
  offending binding and its type and points at self-serve-deploy.md §4.1.

  Two posture calls, now documented rather than incidental: own→own **`service` bindings stay
  rejected** (a hosted vertical is one serving script — no own sibling to bind, and platform
  reach is the router, K-27); own **`d1` stays admitted**, but its `database_id` ownership is
  still unproven and trusted under model-B human admission until platform provisioning injects
  the id (#301). `CONTROL_PLANE` is refused by **name** whatever type it claims, so a
  masquerading binding can't slip through the type check.

  `type` stays a free string at the schema layer on purpose: a refused type produces a named,
  actionable rejection instead of a generic Zod parse error. Decision D-40; §4.1 enumerates the
  full permitted/rejected/why table.

- d4bf108: Surface hostname binding is operator-facing (K-26 multi-surface exposure — the Egeryds
  EKA ask). The vertical side always worked: one scope, one worker, one bundle, and
  `readRoutedNode(...).surface` decides which app the hostname serves. What was missing
  was any way to GIVE a second surface a URL; `bindHostname` existed but nothing
  operator-facing called it.

  The dashboard's Domains tab is now real: it lists an app's bindings (hostname, surface,
  status, canonical), mints a platform hostname for a surface (`crm.global…` + `eka` →
  `crm-eka.global…`, live immediately — it rides the wildcard cert), records a custom
  domain as `pending` into the §4.2 lifecycle, and unbinds with the canonical-demotion
  rule stated in the UI. The default hostname is refused for removal — deleting the app
  retires it. Both mutations gate on `dashboard:provision-app` in the caller's own scope
  and land on the activity trail as `hostname-bound` / `hostname-unbound` (migration 0009
  widens the event CHECK, rebuild-and-copy like 0005–0008). A custom-domain form never
  accepts platform names — that path is the mint, so labels can't be squatted cross-tenant.

  The control plane's hostname routes join `BUILDER_ROUTES`, tenant-narrowed: a builder
  lists only its own tenant's rows (a foreign `tenantId` in the query loses silently),
  binds only into its own tenant, never supplies `region` (an EU-residency claim, K-30),
  and a foreign hostname on status/unbind reads 404 — indistinguishable from absent. CLI
  parity rides that: `substrat hostnames <slug>` lists an install's bindings,
  `… bind <slug> --surface eka [--domain …] [--scope …]` mints or records, `… unbind
<hostname>` removes.

  Verticals may declare their surfaces — package.json `substrat.surfaces: [{ name,
label }]` rides the deploy manifest to the registry like `envSpec` (metadata, not
  behavior, not in any digest; the anchor #111's per-surface operation-sets extend
  later). The declaration buys the Domains tab a picker instead of free text, and a
  push-time warning naming any hostname still bound to a surface the new version stopped
  declaring — the same spirit as the permission-surface gate, advisory tier. Free-text
  surfaces stay valid everywhere; declaring nothing opts out of the check.

## 0.23.0

### Minor Changes

- 6a86837: Builders keep the substrate vocabulary (#190 part B, D-38): a vertical declares what it
  needs from the runtime in Substrat terms — `substrat.runtimeNeeds` in package.json
  (`entry`, `needsNodeCompat`, an optional pre-bundle `build` command, and its own
  `stores`: binding → durable state class) — and never authors `wrangler.jsonc`. At push
  time the CLI derives the wrangler config (`wranglerConfigFor`), feeds it to the bundler
  via `--config` (written next to the vertical, removed after the build), and assembles
  the deploy manifest from the same derived object, so declaration and bundle cannot
  drift. The compatibility date is the platform's `RUNTIME_BASELINE` (new in contracts) —
  a builder states needs, never substrate config.

  The vocabulary is complete at four fields _because_ the §4 sandbox contract is strict:
  it refuses everything except a vertical's own stores, so own-stores + node-compat + a
  build command is the whole of what a builder may legitimately say. Datastores beyond
  own stores are deliberately absent — those are platform-provisioned, never
  bundle-declared. A hand-authored `wrangler.jsonc` remains the expert/legacy path and is
  ignored (with a note) when `runtimeNeeds` is present.

  Honest limit, unchanged from the issue: this neutralizes the _declaration_, not the
  _toolchain_ — wrangler still bundles in the builder's CI.

## 0.22.0

### Minor Changes

- bc6d0fa: In-place deploys (#286, K-33): version updates carry scope data forward. Verticals now
  serve from ONE stable dispatch script per vertical — a prod promote re-uploads the
  promoted version's bundle onto that unchanged name (modules read back from the
  per-version archive script, metadata from the version's retained manifest), so scope
  DOs and their data stay put while the code moves, and kernel migrations finally run in
  place. In-place uploads keep existing secrets (`keep_bindings`) and send only the
  DO-class delta, diffed against directory-recorded serving state. Routing is per-scope
  truth (`scopes.servingRef`, COALESCEd over the bound version's ref); new scopes are
  born on the serving script, legacy scopes hop once via the new adopt-serving endpoint
  (export → restore → flip, data-first). Safety net: versions carry a code-only vs
  schema-change signal (migration-digest diff), the scope DO takes a PITR bookmark
  immediately before an upgrade's migration pass, and a new audited, time-boxed rewind
  (`rewindScope`, 24h window unless forced) restores schema and data to that instant.
  New `/internal/bookmarks`, `/internal/rewind` (and Meridian's previously missing
  `/internal/restore`) vertical routes; new `HostAdmin` methods (`verticalServing`,
  `setVerticalServing`, `versionManifest`, `setScopeServingRef`,
  `scopeMigrationBookmarks`, `rewindScope`).

## 0.21.0

## 0.20.0

### Minor Changes

- d18d788: `buildOpenApiDocument` + `ApiCatalog`: a vertical exports an operation catalog (operation name → summary + the same Zod schemas its handlers parse) and gets an OpenAPI 3.1 document — served live at `/openapi.json` and checked in via `pnpm lint:api` (design/api-surface.md). Uses Zod 4's native draft-2020-12 emit; no new dependencies.
- a39a024: Backup restore / backout (§8's write half): `ScopeHost.restoreScope` loads a
  `ScopeDump` into an EXISTING scope in place (drop-then-replay, migration frontier
  included) — audited as `restoreScope`, refusing unknown scopes. Threaded end to end:
  `restoreScopeLocal` on the Cloudflare host, `/internal/restore` on the vertical
  surface (VerticalClient + the Manyfold reference worker), a staff-only
  `POST /tenants/:tenantId/scopes/:scopeId/restore` control-plane route that delegates
  to the bound version's deployment, and `substrat scope restore <scopeId> --file
<backup>` — accepting a `scope pull` .sqlite, a local adapter-sqlite scope file, or
  a .dump.json.

## 0.19.0

### Patch Changes

- b4a6bee: Routing schemas accept prefixed vertical registry ids: `hostnameBinding.verticalSlug`
  and `routeTarget.verticalSlug` now use the `verticalSlug` schema
  (`<tenantSlug>/<name>` or bare) instead of the bare `slug` pattern. Before this, an
  installed builder vertical's hostname row failed the Zod boundary on read-back, so
  the bind was silently discarded and the app ended up with no URL.

## 0.18.0

### Minor Changes

- d18a247: `HostAdmin.setTenantName` + `PATCH /tenants/:tenantId` — a display-only rename (the
  slug, which registry ids key on, never moves). The dashboard's identity mirror uses
  it to keep the shared directory's tenant names in step with team names, so the CLI's
  workspace picker shows the organization, not a placeholder; the CLI now lists
  workspaces name-first.

## 0.17.0

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

## 0.15.0

### Minor Changes

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

- cd32011: Marketplace apps/verticals split + the empty-marketplace fix.

  **Adapters:** `registerVertical` now refreshes `listed` on an identical re-registration
  of a **builtin** vertical (it is seed metadata, derived from the catalog's `connected`
  flag). Rows registered before the `listed` column existed (migration default 0) were
  stuck unlisted forever, so the hosted marketplace rendered empty. A pushed (`cli`/`git`)
  vertical's `listed` stays untouched — re-pushing a published vertical still cannot
  silently unpublish it.

  **Dashboard:** the create-app page is now pure instantiation, grouped **Marketplace**
  (published) and **Your verticals** (your team's own, badged Private/Published, disabled
  until a version is promoted to prod). The Deployments page is renamed **Verticals**
  (`#/deployments` stays as an alias) and takes over the supply side: the GitHub
  import + one-click CI scaffold move there from create-app. `GET /api/catalog` returns
  `{owned, listed, source, installable}` and, in connected mode, merges the shared
  control plane's registry — so a pushed vertical shows up and (via the same fallback in
  `installSpecFor`) installs in production, not just embedded mode.

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
