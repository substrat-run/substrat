---
status: built
layer: plan
description: Push to your team, publish to everyone.
---

# RFC: the marketplace — push to your team, publish to everyone

**Status:** **built** — listing and installs ship (#213, #691). **Extends:** [builder-plane.md](./builder/plane.md) (tenant-owned
verticals, the ownership claim, builder authz). **Depends on:** the manifest env-spec work
(the registry already carries `envSpec`), [self-serve-deploy.md](./self-serve-deploy.md) (push
seam + models A/B), [dashboard.md](./dashboard.md) (tenant-narrowed provisioning).

## 1. Problem

Marketplace availability is **hardcoded** in `apps/dashboard/src/catalog.ts`. The `CATALOG`
map does two jobs, and both gate on a literal entry:

- **Visibility** — `availableCatalog` filters `verticals` by `CATALOG[v.slug]` (and it's only
  handed `{ connected }`, no tenant).
- **Install** — `createApp` (and Retry) read `entry.entitlements` + `entry.ownerGrants` from
  `CATALOG[v.slug]`; no entry ⇒ `unknown vertical`.

So every new vertical needs a dashboard **code change + redeploy** or it's invisible and
uninstallable — even after `substrat push` + admit + promote. That's the recurring miss (it
bit Manyfold; it's blocking the auth-server now).

[builder-plane.md](./builder/plane.md) already made a vertical **tenant-owned** — `push`
stamps `ownerTenant` on the registry (the pushing tenant, or `null` for first-party). But the
dashboard **ignores** `ownerTenant`, and there is no notion of a vertical being **published**
to the public marketplace. This RFC closes both: make the catalog registry-driven, and add the
publish tier.

## 2. The model — two visibility tiers

Keyed entirely off registry state, no hardcoded map:

- **Private (on push).** `substrat push` ⇒ `ownerTenant = you`, `listed = false`. The vertical
  appears **only in your team's** "install an app" catalog; you can install it. This is the
  builder-plane flow finished — ownership already recorded, now *honoured* by the dashboard.
- **Published.** A `publish` action ⇒ `listed = true`. The vertical appears in **every team's**
  catalog. Publishing exposes code **and a permission surface** to other tenants, so it is a
  trust boundary — **staff-reviewed** in v1 (§5).

Publish is **distinct from promote-to-prod.** Promote-to-prod = "this version is *servable*"
(builder-plane model B, staff-gated). Publish = "*other tenants* may install it." A vertical
must be prod before it can be published; a prod vertical can stay private (your team only).

## 3. The registry becomes the catalog

The `CATALOG` map's two jobs move onto the registry, **carried on push from the manifest** —
exactly the rail the `envSpec` work already laid (`registerVertical` stores it; `GET
/api/catalog` serves it; the dashboard renders from it). New registry `vertical` fields:

| Field | Source | Purpose |
|---|---|---|
| `entitlements` | manifest `entitlementKey` (+ composed engine keys) | what `grantEntitlement` grants on install |
| `ownerGrants` | **new manifest field** `ownerGrants: permissionKey[]` (§3.1) | what the installing owner is granted (scope-provisioning verticals only) |
| `provides` / `requires` | **new manifest fields** — capability lists (§4) | wires providers ↔ consumers via connections |
| `listed` | the publish action (§5) | public-marketplace flag |
| `ownerTenant` | already added by builder-plane §3 | private-to-my-team key |

Then the dashboard reads the registry, not the map:

- `availableCatalog(verticals, { tenantId, connected })` → `v.listed || v.ownerTenant === tenantId`
  (and provisionable in connected mode). The endpoint at `worker.ts:394` starts passing the
  caller's tenant (it already resolves the account).
- `createApp` reads `entitlements`/`ownerGrants` **from the registry row**, and installs by the
  vertical's declared `provides`/`requires` (§4).
- **First-party verticals** (Documents, Meridian, Manyfold) become seeded rows —
  `ownerTenant: null, listed: true` — written by `ensureCatalog` from their manifests. The
  `CATALOG` map shrinks to a *first-party seed list*, never a visibility/install **gate**.

This step alone is what removes the recurring miss: a pushed, promoted, published vertical
shows and installs with **no dashboard edit**.

## 3.1 What the manifest adds — permissions vs roles

The manifest declares **permission keys** (`permissions: { key, description }[]`), *not* roles.
Roles — named bundles of those keys — are **vertical vocabulary**: they live in the vertical's
provisioning (`RoleDefinition[]` → `defineRole` per tenant) and stay **runtime-customizable**
(a tenant admin shapes roles in the console, control-plane §4.5). That's the three-layer rule,
and it's why the full role table is deliberately **not** pushed — freezing it into the manifest
would kill per-tenant role customization.

So for registry-driven install we add exactly **one** small declarative field to the manifest:
**`ownerGrants: permissionKey[]`** — the minimal permissions a fresh install's owner needs on
day one. Additive (D-28), frozen like the rest of the permission surface, and all `push` needs
to carry so `createApp` can grant the owner without the hardcoded map. The role *table* stays
where it belongs; only the day-one owner grant is declared. (Decides §8's old "manifest vs
derived-from-`ROLES`" question in favour of the small manifest field.)

`ownerGrants` applies only to verticals that **provision a scope**: a pure capability provider
(the auth-server) makes no scope grants, so it declares none — its `envSpec` is its install
surface (§4).

### Declaring `entitlements` when the key diverges from the slug (#691)

`installEntitlements` grants the **declared** set when there is one, else derives from the
slug's bare last segment. That default is only right when the vertical follows the convention
`manifest.entitlementKey === <bare slug>`. When they diverge — a vertical ships slug `crm-eff`
with `entitlementKey: 'field-ops'` — no derivation can bridge the gap, because **the manifest
never reaches the control plane**: `push` sends what the CLI reads from `package.json`, and
the CP never evaluates module code. The vertical must therefore declare it:

```json
{ "substrat": { "entitlements": ["field-ops", "absence"] } }
```

The set is every key the install should grant — the vertical's own plus each composed
engine's, since **each engine a vertical composes adds a key** (`engine-absence` → `absence`).
Adopting an engine without adding its key leaves that engine's operations denying while the
rest of the vertical works, which is a legitimate SKU gate and therefore *not* something the
platform can refuse the install over.

Get it wrong and the failure is latent, not immediate: an un-projected scope trusts upstream,
and the flip to strict enforcement is one-way, triggered by the **first** projection carrying
entitlements (a `fanOut`, a reconcile, a re-provision). So a mismatch planted at install
detonates arbitrarily later, from an unrelated action. The refusal the caller receives names the
operation and its required key only (#3105): the keys the tenant holds are other products'
names, and the caller need not manage the tenant. The host writes required *and* held keys,
expired ones marked, to a server-side `entitlement-denied` log line keyed by the request id
(`x-substrat-request-id`), so an operator handed that id reads the gap at a glance.

## 4. Capabilities, not kinds — verticals provide/require, connections wire them

"Dispatch vs standalone" is the wrong axis — both are verticals/workers. What differs is the
**consumption model**, and it's cleaner (and more honest — the auth-server is just a vertical
other verticals talk to) to declare it as capabilities than a rigid `kind` flag:

- A vertical's manifest declares **`provides: capability[]`** and **`requires: capability[]`**.
  The auth-server `provides: ['oidc-issuer']`; an app that delegates auth `requires:
  ['oidc-issuer']` (optional). A vertical may do both.
- **Install provisions the vertical's own state either way.** A routed end-user app gets a scope
  (`provisionScope` → `grantEntitlement` → grant `ownerGrants` → bind
  `<app>.<jurisdiction>.substrat.run`, the router dispatches the WfP version); the auth-server
  gets its per-tenant issuer DO. The difference isn't a code kind — it's what it *declares*.
- **A provider becomes bindable; a requirer gets bound — through the connection store**
  ([connections.md](./connections.md)), keyed `(tenant, vertical, provider)` with the authority
  originating in-scope. Installing a requirer prompts "bind `<capability>`": pick an existing
  provider instance in your tenant, or install one.

**Auth is per-tenant, which is why this composes.** The identity DO is one-per-tenant
(`idFromName(tenantId)`) — credentials/login are tenant-level; K-22 maps that one login to a
different principal per scope. So a bound `oidc-issuer` serves **all** a tenant's requiring
verticals → single sign-on across their apps, which is the whole point of separating auth. **One
issuer per tenant** (or a shared platform one), **never per scope, never bundled** into a
consumer's manifest. The consuming vertical already has the seam: `AUTH_PROVIDER=oidc` +
`OIDC_ISSUER` — set them and it delegates to the bound issuer instead of its embedded IdentityDO.

So there is **no `kind` flag**: the registry carries `provides`/`requires` capability lists (from
the manifest), `ownerGrants`/`entitlements` are populated only for verticals that provision a
scope, and `createApp` reads the declarations rather than assuming one shape.

## 5. The publish gate

**Decided: staff review, open to anyone.**

- `substrat push` → private (`ownerTenant = you`, `listed = false`).
- `substrat publish <slug>` (or a dashboard button) → **requests listing**. **Anyone who owns a
  vertical may request** — there is no separate "publisher" entitlement gating *who* can
  publish; the staff review is the only gate. A staff reviewer then flips `listed = true`.
- The review is the existing **permission-diff** checkpoint, now applied where a vertical
  becomes *other people's* risk: the reviewer reads which permissions an installing owner is
  granted (`ownerGrants`) and the vertical's declared permission surface — same trust posture
  and mechanism as prod-promotion (builder-plane **model B**).
- `unpublish` → `listed = false`. Delists from the public catalog; **existing installs keep
  running** (K-21 tombstone, never yank a running instance).
- **Later: AI review + automatic validation** relax the staff gate (self-serve-deploy.md model
  A). An inspecting pipeline (permission-diff sanity, sandbox-contract + boundary-lint replay,
  an LLM reviewer for the declared surface) can mechanically vet a bounded vertical and
  auto-admit, escalating only the uncertain cases to staff. The mechanism is identical — only
  *who signs off* changes — so this is additive, not a rework.

**Authz** (extends builder-plane §4): `publish`/`unpublish` are owner-tenant actions — any
owner may *request* the `listed` flip; the flip itself is staff-admitted, the same asymmetry as
"builder promotes dev/staging, staff promotes prod." Owning a vertical (having pushed it) is the
only prerequisite; there is no additional publish entitlement.

## 5.1 Versioning — installs follow within a major, and a breaking change is a new major

[K-65](../decisions/K-065-one-version-rule-an-install-follows-its-app-within-a-major-and-a-breaking-change-is-a-new-major-served-beside-the-old.md)
decides this. It replaces what this section used to promise: that an install pins its version, and
that a publisher cannot upgrade a running install. That promise could not hold once an app served
in place from one script
([K-33](../decisions/K-033-verticals-serve-in-place-from-one-stable-script-per-version-.md)): a
scope's data belongs to the script that serves it, and a listed promote has re-provisioned every
install since (#1653).

- **`listed` tracks the vertical's `prod` channel.** A new install binds to prod's current version.
  Publishing does not freeze a snapshot, and the tile always offers the latest prod.
- **An install follows the publisher within a major.** A promote within the major reaches every
  install, paced by the listed reconcile (`PROVISION_RECONCILE_BATCH`, 50 per pass). Each install is
  told, with K-33's badge: **code-only** or **schema-change**. A schema-change update applies on its
  own. The point-in-time bookmark taken before the migration pass, and `rewindScope`, are the net.
- **A breaking change is a new major, served by its own script beside the old one.** An install
  moves to it when its tenant chooses, through `adopt-serving`. The old major keeps serving, and may
  still take additive releases, until its end date: at least 90 days after the new major's release,
  or later if the publisher says so.
- **The platform refuses a breaking change within a major.** A listed promote is classified by the
  rules `substrat changeset` and `lint:changeset-bump` use. One ranked major, or one the classifier
  cannot rank, is refused unless it goes to a new major.
- **Builders can roll back.** Re-pointing `prod` at an earlier, already-admitted version is the
  revert path for a bad release. It is a promote like any other, so it reaches every install on the
  major.
- **The app's owner keeps its own bindings.** An owner can still bind a scope it owns to a version,
  as a canary for its own tenants (`substrat scope bind`). A tenant that installed someone else's
  listed app holds no such binding.

**Built:** the channel, the listed reconcile, the badge, the bookmark, `rewindScope` and the
classifier. **Not built:** a serving script per major, a major's end date, the notice to an
install, the refusal of a breaking listed promote, and `adopt-serving` between majors of one app.
**Not decided:** what happens to an install still on an old major at its end date, and whether a
release within a major that asks for more permissions waits for the installing tenant's approval.

## 6. Registry schema (append-only)

The declarative source is the **manifest**, which gains additive fields: `ownerGrants:
permissionKey[]` (§3.1) and `provides` / `requires` capability lists (§4). `entitlements` derives
from the existing `entitlementKey` (+ composed engines). The four provisioning fields
(`entitlements`, `ownerGrants`, `provides`, `requires`) ride on the `verticals` row as **one
`install_spec` JSON column** (added via the existing `ensureColumn` helper, like `env_spec` /
`owner_tenant`); `listed` is its own int column. All additive (D-28), populated by
`registerVertical` from the pushed manifest, in **both adapters** (sqlite + cloudflare).
**Migration-diff checkpoint** on the new columns.

## 7. Phased plan

1. **Manifest + registry fields + push carries them.** Add `ownerGrants: permissionKey[]` and
   `provides`/`requires` capability lists to `moduleManifest` (additive; `entitlements` derives
   from `entitlementKey`); add `entitlements`/`owner_grants`/`provides`/`requires`/`listed`
   columns to the `verticals` row, read from the manifest by `substrat push` → `registerVertical`
   (append-only migration, both adapters). No behaviour change yet — `CATALOG` still gates.
   *(Checkpoint: migration diff.)*
2. **Registry-driven `availableCatalog` + `createApp`.** Pass `tenantId`; filter on
   `listed || ownerTenant`; read specifics from the registry; install by `provides`/`requires`
   (provision a scope + grants where declared, register/bind capabilities via connections). Seed
   first-party as `listed: true`. **This removes the hardcoded map**
   and the recurring miss. *(Checkpoint: permission diff — first-party `ownerGrants` now come
   from manifests.)*
3. **Publish action + gate.** `listed` write behind staff admission; `substrat publish` +
   a dashboard "Publish to marketplace" button + the request/review surface (builder-plane §8's
   "promote request" question, resolved for publish).

Phase 2 unblocks the auth-server + Manyfold self-registering; phase 3 is the public tier.

## 8. Open questions

- **Provider-instance deployment** — installing a capability *provider* (the auth-server)
  deploys a per-tenant issuer instance. Is that a per-tenant WfP upload of the same bundle, or
  one shared worker keyed by hostname/tenant? And where do its `envSpec` **secrets** live —
  per-app worker secrets (its own script) vs the connection store?
- **Pricing / revenue** — publishing itself is open (§5), but is there a paid/revenue-share
  surface behind a *listed* vertical (builder-plane §8 hinted a publisher handle)? Orthogonal to
  the gate; parked.
