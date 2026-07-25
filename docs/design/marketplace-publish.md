# RFC: the marketplace — push to your team, publish to everyone

**Status:** proposed · **Extends:** [builder-plane.md](./builder-plane.md) (tenant-owned
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

[builder-plane.md](./builder-plane.md) already made a vertical **tenant-owned** — `push`
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
- **First-party verticals** (Callout, Documents, Meridian, Manyfold) become seeded rows —
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

## 5.1 Versioning — marketplace tracks prod, installs pin, upgrade is opt-in

Reuses machinery that already exists: a scope **binds a specific version** (distinct from the
prod channel — `introspect-bound-version`), the dashboard shows an **"update available"** hint
when prod moves past a scope's bound version, and **"update app"** rebinds the scope to prod
(#213). The marketplace model is just those, stated:

- **`listed` tracks the vertical's `prod` channel** — a new install binds to prod's *current*
  version. Publishing doesn't freeze a snapshot; the tile always offers the latest prod.
- **Installed instances pin to their bound version — upgrading is the owner's call.** A scope
  stays on the version it was bound to; the owner rebinds to prod when *they* choose. So
  **older versions run in the wild by design** — a publisher cannot force-upgrade a running
  instance (keeps the "nothing changes under a tenant unasked" trust story).
- **Builders can roll back** — re-pointing `prod` at an *earlier already-admitted* version is
  the revert path for a bad release. Re-promoting a version that already passed admission is
  lower-risk than admitting new code, so it can be lighter than a first-time prod promotion;
  new installs then get the rolled-back version and owners see it as their upgrade target.

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
