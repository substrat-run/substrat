---
status: built
layer: plan
description: Portal-driven vertical deploy. Superseded in part by D-37/K-33.
---

# Portal-driven vertical deploy — the orchestration layer

**Status:** **built** — `substrat push/promote/preview`, dispatch namespaces; the serving half is superseded by D-37/K-33. This is the layer [first-flow](first-flow.md) §5
deferred ("the deploy *trigger*") and D-34 named ("*we* deploy, with *our* credentials").
It commits to a **target** — Workers for Platforms dispatch namespaces (K-28) — and to a
**shape**, not yet to line-by-line implementation. It builds on the registry model that is
**already shipped** (§2), so most of this is surface + actuation, not a new data model.

Read alongside [control-plane](control-plane.md) §4 (the directory this writes to),
[kernel-design](kernel-design.md) K-28/K-29/K-30/K-31 (WfP fits, readiness, residency,
pull-provisioning) and [first-flow](first-flow.md) (the walking skeleton this is the
next step after).

**One decision up front (D-34 refined):** the reach mechanism is **Workers for Platforms
dispatch namespaces**, not the ordinary-upload-plus-static-binding path. D-34 said "build
against the ordinary Workers upload API first". That is right for proving *upload* works,
but the ordinary path leaves the router's *reach* on static service bindings — so adding a
vertical would rewrite and redeploy the router and the control plane on every push, which
is exactly the churn a portal-driven deploy exists to remove. WfP makes `verticalFor` a
one-line `env.DISPATCH.get(name)` (K-28) and makes reach dynamic. WfP is a paid add-on
(`code: 10121`, D-35); enabling it is a prerequisite of this layer, not a later swap.

---

## 1. The goal, as one testable sentence

> A vertical's built worker is handed to the platform (portal button or CLI). The platform
> uploads it into the dispatch namespace **with its own credentials** — the vertical author
> never holds a Cloudflare token — records a `verticalVersion` (pending) with its digests,
> a human admits it at the permission and migration checkpoints, a readiness probe confirms
> the uploaded script is dispatchable, the `prod` channel is promoted to it, and a scope
> bound to that version serves through the router via `env.DISPATCH.get(deploymentRef)` —
> with no redeploy of the router or the control plane at any point.

When that sentence is a passing test against real deployed workers, the layer is done.

## 2. What already exists (do not rebuild)

The survey that preceded this RFC found the **registry data model is fully built** — in
[contracts/src/registry.ts](../../packages/contracts/src/registry.ts), in **both** adapter
tables (`vertical_versions`, `vertical_channels`), in the `ControlPlaneDO` methods, and on
`HostAdmin`, exercised by contract-tests. Specifically already present:

- **Schemas:** `vertical`, `verticalSource`, `verticalVersion` (with `manifestDigest`,
  `permissionDigest`, `migrationDigest`, nullable `deploymentRef`, `admission`),
  `admissionStatus` (`pending | admitted | rejected`), `verticalChannel`
  (`dev | staging | prod` → `versionId`), `promotionAcknowledgement`.
- **`HostAdmin` methods:** `registerVertical`, `publishVersion` ("Lands PENDING — a push is
  not a deploy"), `listVersions`, `admitVersion`, `rejectVersion`, `promoteVersion` (the
  **digest-diff gate** — refuses to promote across a changed permission or migration digest
  unless the matching `promotionAcknowledgement` flag is set), `listChannels`,
  `bindScopeVersion` (refuses a non-`admitted` version). Each writes an admin-log entry.
- **The scope pointer:** `scopes.vertical_version_id` and `scopes.schema_version` already
  exist; `bindScopeVersion` sets them.
- **`VerticalClient.provisionInstance`** + the vertical's `/internal/provision` +
  `POST /verticals/:slug/instances`, all behind `PLATFORM_SECRET` (K-31), already work.
- **The router's readiness retry** for `Worker not found.` is written but "armed, not
  active" (K-29) — it only fires on a dispatch-namespace error, i.e. once *this* layer
  lands.
- **`defineScopeDO(MODULES)`** already makes a vertical *be* a SQLite Durable Object, and
  `wrangler deploy` already uploads exactly the DO-migration metadata
  (`new_sqlite_classes`) a programmatic upload must reproduce.

**What is absent, and is therefore this layer:** an HTTP surface for those `HostAdmin`
methods; a console view for them; the programmatic **uploader** (sets `deploymentRef`); the
**dispatch-namespace reach** (`env.DISPATCH`); and the **readiness gate** (K-29). Nothing
below invents a new directory contract — it wires the built one to a surface and an
actuator.

## 3. The shape: dispatch namespaces

A single **dispatch namespace** (say `substrat-verticals`) holds every vertical's uploaded
worker as a user script. Two platform workers gain a `dispatch_namespaces` binding
`DISPATCH` to it:

- **Router** — `verticalFor` swaps `env["VERTICAL_" + SLUG]` for `env.DISPATCH.get(name)`.
  Same `Fetcher` type, one function (K-28). Then the router's static `VERTICAL_*` service
  bindings disappear, and adding a vertical never touches the router again.
- **Control plane** — `verticalsFor` does the same, so provisioning
  (`VerticalClient.provisionInstance`) also reaches dynamically-uploaded verticals with no
  redeploy.

**Why this and not ordinary scripts (D-30 holds either way):** each vertical is a separate
script with its own DO classes — D-30's no-lockstep-upgrades property — under both models.
Dispatch adds the one thing ordinary scripts cannot: *the router reaches a script that did
not exist when the router was deployed.* That is the whole of "portal-driven".

## 4. The version lifecycle, mapped onto the built model

The existing schema already encodes the states; this layer adds the transitions. The
ordered lifecycle of a version:

```
build ──▶ publish ──▶ admit ──▶ deploy ──▶ readiness ──▶ promote ──▶ bind ──▶ serve
 (CI)     (pending)  (checkpts) (upload)   (probe)      (channel)  (scope)  (router)
```

| Step | What happens | Where it lands |
|---|---|---|
| **build** | vertical source → worker bundle + DO-migration metadata + the three digests | outside the Worker (§5.1) — CI or `wrangler --dry-run --outdir` |
| **publish** | record a `verticalVersion` **pending** with digests; `deploymentRef` null | `publishVersion` (built) + a new HTTP route |
| **admit** | a human reviews the permission-diff and migration-diff (the two D-22/D-29/§4 checkpoints), `admitVersion` | `admitVersion` (built) + route + console |
| **deploy** | upload the bundle into the dispatch namespace under `deploymentRef`; set `deploymentRef` on the version | **new uploader** (§5.2) |
| **readiness** | probe `DISPATCH.get(deploymentRef)` until dispatchable (K-29) | **new gate** (§5.5); sets a new `deploymentStatus` |
| **promote** | move a channel (`prod`) to the version — through the digest-diff gate | `promoteVersion` (built) + route + console |
| **bind** | pin a scope to the version (`vertical_version_id`); refuses non-admitted | `bindScopeVersion` (built) |
| **serve** | router dispatches `DISPATCH.get(deploymentRef)` for the scope's bound version | §5.4 |

The critical property the order protects (K-29, K-30): **a channel is never promoted and a
hostname is never bound to a version until the readiness probe passes** — upload-succeeded
is not ready-to-serve.

## 5. The pieces to build

### 5.1 Build — source to bundle (outside the Worker)

A `workerd` runtime cannot run esbuild, so the **bundle step cannot live in the control-plane
Worker.** It runs where node does: the vertical's own CI (the eventual customer path) or, for
our platform-owned verticals, a repo build. Concretely: `wrangler deploy --dry-run --outdir`
already emits the bundled module(s) and the resolved migration metadata; the uploader
consumes that artifact rather than re-implementing the bundler. **Decision:** build and
upload are separate steps with a defined artifact between them (bundle + `new_sqlite_classes`
+ digests), so the customer's CI can be the producer later without changing the uploader.

### 5.2 Upload — into the dispatch namespace

The uploader is the one piece the K-28 spike (`368b340`, since removed) proved and this layer
resurrects properly: a multipart `PUT` to
`…/accounts/{acc}/workers/dispatch/namespaces/{ns}/scripts/{deploymentRef}` with metadata
`{ main_module, migrations: { new_tag, new_sqlite_classes: [...] } }`. It runs with a
**platform-held, WfP-scoped API token** — the vertical author never holds a Cloudflare
credential (D-34, "the whole of *we host it*"). On success it sets `deploymentRef` on the
version. The uploader can run from the control-plane Worker (it is just an authenticated
HTTP call) or from the same node context as the build — see the open decision in §8 about
where the artifact lives between publish and deploy.

### 5.3 `deploymentRef` and naming — archive scripts per version, ONE serving script per vertical

> **Superseded in part (K-33, #286).** The original decision — each version its own
> dispatch script, scopes dispatched to their bound version's script — priced the
> scripts as stateless. They are not: the scope DO *is* the app, a DO namespace
> belongs to its script, and so rebinding a scope to a new version rebound it to
> **empty storage**. The benefits claimed were illusory for stateful scopes (a scope
> could never actually move versions without abandoning its data, so per-scope
> pinning only ever worked for empty scopes, and rollback-by-repointing resurrected
> stale data), while the cost was fatal: the kernel's append-only `SqlMigration[]`
> machinery never met production data, replaced by a manual backup→update→restore
> ritual per deploy.

**Decision (revised):** per-version scripts survive as the **push archive** —
`deploymentRefFor(slug, versionId)`, where a push uploads, admission reviews, and the
bundle bytes live — but serving happens from **one stable script per vertical**
(`stableDeploymentRefFor(slug)`). A prod promote re-uploads the promoted version's
bundle onto that unchanged name (modules read back from the archive script; metadata
rebuilt from the version's retained manifest), so every scope's Durable Objects — and
therefore its data — stay put while the code moves, and migrations finally run in
place exactly as the kernel designed. In-place uploads keep existing secrets
(`keep_bindings`) and send only the DO-class *delta* under a bumped migration tag,
diffed against directory-recorded serving state — no deploy guesses Cloudflare state.

Scope routing is **per-scope truth**: `scopes.serving_ref` names the script a scope's
data lives in (set at provision for scopes born on the serving script; set by the
one-time **adopt-serving** hop — export → restore into the serving script → flip —
for legacy scopes), and `readHostname` resolves `COALESCE(serving_ref, bound
version's ref)`. What is conceded is per-scope staged rollout across versions —
which one shared namespace never truly offered — so blast radius stays per-vertical,
the boundary D-30 drew. The safety net replacing it (#286): versions are badged
**code-only vs schema-change** at publish (a migration-digest diff against the
predecessor — the same signal promote's acknowledgement gate reads); the scope DO
takes a **PITR bookmark** immediately before an upgrade's migration pass; and a
time-boxed **backout** (`rewindToBookmark`, 24h window without force) restores schema
and data to that instant, with #278's backup/restore as the considered path beyond
the window. Old archive scripts are garbage-collected once no scope and no channel
reference them, as before.

### 5.4 Reach — dispatch + per-scope version resolution

`verticalFor`/`verticalsFor` become `env.DISPATCH.get(name)`. The open question is **what
`name` is.** The router resolves a hostname to a `RouteTarget` that today carries
`verticalSlug` but **not** a version. Two options:

- **(a) dispatch on slug** → every scope of a vertical runs whatever the `prod` channel
  points at. Simple, but forecloses per-scope pinning and staged rollout that the registry
  model already supports.
- **(b) dispatch on the scope's bound version's `deploymentRef`** → honours
  `scopes.vertical_version_id`, enables staged rollout, and matches §5.3.

**Recommendation: (b).** To keep the router's hot path one directory read, **denormalize the
bound `deploymentRef` into the route target** (as `verticalSlug` is denormalized today),
updated whenever a scope binds a version. The alternative — a second DO read (scope →
version → ref) per request — doubles the hot-path reads the router deliberately keeps to one
(K-26, open question 5). This denormalization is the one genuinely new field on the routing
path and is called out as an open detail in §8.

### 5.5 Readiness — the K-29 gate made real

After upload, add a bounded readiness probe: dispatch a health request to
`DISPATCH.get(deploymentRef)` until it answers (not `Worker not found.`), then mark the
version ready. This is where K-29's deferred `deploymentStatus` on `verticalVersion` becomes
real (`uploading → ready → failed`). `promoteVersion` and `bindScopeVersion` refuse a version
that is not `ready`. The router's existing bounded retry remains the *runtime* backstop for
the residual per-colo propagation gap; the readiness gate is the *pre-promotion* proof.

### 5.6 HTTP API surface

New routes on `createControlPlaneApi`, all behind the existing staff/session or service
auth (K-27/K-31), one per built `HostAdmin` method plus deploy:

```
POST   /verticals                         registerVertical
GET    /verticals                         listVerticals
POST   /verticals/:slug/versions          publishVersion            (pending)
GET    /verticals/:slug/versions          listVersions
POST   /verticals/:slug/versions/:id/admit    admitVersion          (checkpoint)
POST   /verticals/:slug/versions/:id/reject   rejectVersion
POST   /verticals/:slug/versions/:id/deploy   → uploader (§5.2), sets deploymentRef
POST   /verticals/:slug/channels/:ch/promote  promoteVersion (+ acknowledgement body)
GET    /verticals/:slug/channels          listChannels
POST   /scopes/:id/version                bindScopeVersion
```

`deploy` is the only route that is more than a thin `HostAdmin` pass-through — it is the
uploader. Everything else already exists below the transport and just needs exposing. Note
the deliberate omission consistent with first-flow §4: role/grant writes stay off this
surface; the permission model is admitted as a **digest**, reviewed as a diff, never pushed
as verbs.

### 5.7 Console — the surface staff drive

A new **Verticals** section: list verticals; per vertical, a versions table (version,
digests summarised as "permissions changed / migrations changed" badges, admission state,
`deploymentStatus`); admit/reject actions gated so admit surfaces the permission-diff and
migration-diff for the human to read; a channels row with promote actions that route through
the acknowledgement flow when a digest changed. `CreateInstance` gains a version/channel
choice where today it assumes one. This is where the two human checkpoints (§6) become
things a person clicks through, not CI output.

## 6. Trust and the two human checkpoints

- **Platform holds the Cloudflare credential, the author never does** (D-34). The WfP-scoped
  token lives as a control-plane secret. A vertical author hands over *code*, not *access*.
- **Dispatch isolation** (K-28): a user script in the namespace defines its own DO classes;
  D-30's no-lockstep property holds by construction. A vertical cannot reach another's DO.
- **Admission is the gate, digests are the evidence.** `publishVersion` records
  `permissionDigest` and `migrationDigest`; `promoteVersion` refuses to cross a changed one
  without an explicit `promotionAcknowledgement`. This is the mechanical home of the two
  human checkpoints the project already runs in CI (`boundary-lint`, permission-diff,
  migration-diff) — now enforced at the moment a version would start serving, not only at
  merge. **CI going red and a human reading a diff both remain; this makes the reading
  unskippable at deploy, not a substitute for it.**
- **Untrusted authors are still out of scope** (generated-verticals §1): this layer is the
  *trusted-author, platform-owned-deploy* path. An untrusted zip/CLI path is a separate,
  later, harder decision.

## 7. Migrations across a version upgrade

Two migration layers, and this layer must keep them distinct:

- **DO class migrations** (`new_sqlite_classes`) — carried in the upload metadata (§5.2),
  identical to what `wrangler deploy` synthesises today. Needed only when a *new* DO class
  appears; the common upgrade adds none.
- **Per-scope schema migrations** — the module `SqlMigration[]` run lazily inside each scope
  DO on first touch after an upgrade (already built, `applyPendingMigrations`, keyed
  `module_id@version`). A scope that fails a migration fails closed and records
  `migrationFailure` — already modelled. The reconciliation sweep (#49) becomes load-bearing
  here: after promoting a channel, scopes migrate lazily and independently, so "487/500
  migrated, 13 pending, 0 failed" must be observable. The `migrationDigest` on the version is
  what the admit checkpoint reviews before any of this runs.

The upgrade contract from CLAUDE.md holds unchanged: migrations are append-only; emitted
event fields freeze; a rename is a `schemaVersion` bump with a dual-emit window. This layer
does not relax it — it makes the digest that proves it a promotion gate.

## 8. Open decisions

1. **Where the built artifact lives between `publish` and `deploy`.** Publish records a
   pending version with digests but no bundle; deploy needs the bundle. Options: (a) store
   the bundle in **R2** keyed by `versionId` at publish, read at deploy — adds an R2
   dependency the platform does not yet use; (b) the CI tool holds the bundle and calls
   `deploy` only after an admission webhook — no storage, but couples deploy to the CI
   session; (c) **upload to the dispatch namespace at publish** and re-read "a push is not a
   deploy" to mean *uploaded-but-unreferenced* rather than *not-uploaded* — no storage, and
   `bindScopeVersion` already refuses non-admitted versions, so nothing serves until
   admitted. (c) is the cleanest and is the recommendation, but it reinterprets
   `deploymentRef` as "present in the namespace" rather than "serving", which the current
   comment ("Null until something is deployed") should be updated to match.
2. **The routing hot-path field (§5.4):** denormalize `deploymentRef` into the route target
   vs a second DO read. Recommendation denormalize; confirm against the K-26 open-question-5
   cache decision when that lands.
3. **Dispatch name scheme (§5.3):** `<slug>@<version>` vs `<slug>-<versionId>`. Cosmetic but
   stable-forever once a scope pins it; pick before the first upload.
4. **One namespace or per-jurisdiction namespaces?** K-30 deploys verticals per jurisdiction.
   A dispatch namespace is account-global; residency may want `substrat-verticals-eu` etc.
   Tied to when eu/us jurisdictions actually open (K-32) and Regional Services is bought —
   defer with them, but do not name the namespace in a way that forecloses it.
5. **Old-version GC:** when and how a `deploymentRef` no scope and no channel references is
   deleted from the namespace. Hygiene, not a blocker.

## 9. Non-goals (explicitly deferred)

- **Untrusted-author deploy** (generated-verticals §1) — trusted, platform-owned only. The
  self-serve extension (a builder deploying their own vertical via `substrat push`) is designed
  separately in [self-serve-deploy](self-serve-deploy.md); its foundation is this layer's Phase 2.
- **The trigger ergonomics** — a git-hook or a `substrat push` CLI are sugar over the
  `deploy` route; this layer builds the route, not the ergonomics.
- **Per-jurisdiction dispatch namespaces** — until eu/us open (K-32) + Regional Services.
- **Hostname DNS/cert provisioning** — still by hand (first-flow §5); the router route and
  ACM wildcard are the platform-ops step, not part of this layer.
- **Billing/meters** — D-30, out of scope.

## 10. Phasing

1. **Registry surface (fork-agnostic, unblocked).** §5.6 HTTP routes + §5.7 console view over
   the already-built `HostAdmin` methods. No Cloudflare API, no WfP. **DoD:** a staff user can
   register a vertical, publish a version (pending), admit it, and promote a channel from the
   console; `deploymentRef` stays null and nothing serves yet.
2. **Upload orchestration (needs WfP enabled).** §5.1 build artifact + §5.2 uploader + the
   `deploy` route + §5.3 naming. **DoD:** `POST …/deploy` uploads `substrat-fsm` into the
   dispatch namespace and sets `deploymentRef`; `DISPATCH.get(ref)` answers.
3. **Reach + readiness.** §5.4 `verticalFor`/`verticalsFor` swap + route-target denormal +
   §5.5 readiness gate + `deploymentStatus`. **DoD:** the §1 sentence passes — a scope bound
   to a deployed version serves through the router with no platform redeploy, and a channel
   cannot be promoted onto a version whose readiness probe has not passed.

Phase 1 is worth starting regardless of anything else because it is the surface both later
phases need and it lands the human checkpoints in the UI.

## 11. Definition of done

The §1 sentence is an automated end-to-end test against real deployed workers: build →
publish → admit → deploy → readiness → promote → bind → a request on the scope's hostname
served by the dispatched version — with the router and control plane never redeployed across
the whole sequence. When it is green, "portal-driven deploy" is real, and the deferred
questions in §8–§9 become scoped work instead of speculation.
