# @substrat-run/demo-manyfold

## 0.6.27

### Patch Changes

- Updated dependencies [f869541]
- Updated dependencies [f869541]
- Updated dependencies [19fb697]
- Updated dependencies [f869541]
- Updated dependencies [717600e]
- Updated dependencies [46b1cac]
- Updated dependencies [9208b4e]
  - @substrat-run/kernel@0.72.0
  - @substrat-run/adapter-sqlite@0.72.0
  - @substrat-run/adapter-cloudflare@0.72.0
  - @substrat-run/contracts@0.72.0
  - @substrat-run/vertical-host@0.72.0

## 0.6.26

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
  - @substrat-run/adapter-cloudflare@0.71.0
  - @substrat-run/adapter-sqlite@0.71.0
  - @substrat-run/kernel@0.71.0
  - @substrat-run/vertical-host@0.71.0

## 0.6.25

### Patch Changes

- ef4a747: The four demos that predate the model phase declare their entities.

  Every demo now has a registry and a checked-in `model.json`; `lint:model` covers
  six models instead of two. Entity names in `attachmentTargets` and relation edges
  are checked, and local `entityRelations` are DERIVED from the entities' own
  `parents` rather than written twice — shop's `variant → product` and
  `order → customer` both fall out of the declaration.

  Cross-engine edges are checked too, now that every engine exports a registry:
  meridian's `protocol → employee` against engine-protocol, rally's
  `reservation → member` against engine-booking.

  This is the entity half only. Declaring each demo's operations is a much larger
  piece — meridian alone has ~20 — and its main payoff (declared returns for a
  lane fork) is not needed yet.

  Two things worth recording, both found by doing this rather than assuming:

  **Meridian emits about an entity with no table.** `payroll-run` is an entity type
  with an id minted at emit time and no row anywhere — an event about an
  occurrence, not a stored thing. `EntityDef` requires a table, so the registry
  cannot describe it. Harmless for the entity half; it will bite when operations
  are declared, because `emits.entity` is checked against the registry.

  **Manyfold creates tables at runtime.** A content type builds its own `ct_<key>`
  table when it is defined, so those names do not exist at build time and a
  registry keyed by static table names has nothing to say about them. They are also
  not entities: the ENTRY is the thing, and its typed fields live in its `ct_` row.

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0
  - @substrat-run/adapter-cloudflare@0.70.0
  - @substrat-run/adapter-sqlite@0.70.0
  - @substrat-run/kernel@0.70.0
  - @substrat-run/vertical-host@0.70.0

## 0.6.24

### Patch Changes

- Updated dependencies [17a82ec]
  - @substrat-run/contracts@0.69.0
  - @substrat-run/adapter-cloudflare@0.69.0
  - @substrat-run/adapter-sqlite@0.69.0
  - @substrat-run/kernel@0.69.0
  - @substrat-run/vertical-host@0.69.0

## 0.6.23

### Patch Changes

- Updated dependencies [60789c8]
- Updated dependencies [aaf41b8]
- Updated dependencies [a05cd4d]
- Updated dependencies [b9dbda9]
- Updated dependencies [4eb532b]
  - @substrat-run/contracts@0.68.0
  - @substrat-run/kernel@0.68.0
  - @substrat-run/adapter-sqlite@0.68.0
  - @substrat-run/adapter-cloudflare@0.68.0
  - @substrat-run/vertical-host@0.68.0

## 0.6.22

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
- Updated dependencies [ee95fd6]
  - @substrat-run/contracts@0.67.0
  - @substrat-run/kernel@0.67.0
  - @substrat-run/adapter-cloudflare@0.67.0
  - @substrat-run/adapter-sqlite@0.67.0
  - @substrat-run/vertical-host@0.67.0

## 0.6.21

### Patch Changes

- Updated dependencies [954668b]
  - @substrat-run/kernel@0.66.0
  - @substrat-run/adapter-cloudflare@0.66.0
  - @substrat-run/adapter-sqlite@0.66.0
  - @substrat-run/vertical-host@0.66.0
  - @substrat-run/contracts@0.66.0

## 0.6.20

### Patch Changes

- Updated dependencies [daae585]
  - @substrat-run/contracts@0.65.0
  - @substrat-run/adapter-cloudflare@0.65.0
  - @substrat-run/adapter-sqlite@0.65.0
  - @substrat-run/kernel@0.65.0
  - @substrat-run/vertical-host@0.65.0

## 0.6.19

### Patch Changes

- Updated dependencies [c19e371]
- Updated dependencies [6ac51d1]
  - @substrat-run/contracts@0.64.0
  - @substrat-run/kernel@0.64.0
  - @substrat-run/adapter-sqlite@0.64.0
  - @substrat-run/adapter-cloudflare@0.64.0
  - @substrat-run/vertical-host@0.64.0
  - @substrat-run/vertical-auth@0.7.0

## 0.6.18

### Patch Changes

- Updated dependencies [5e71e1c]
  - @substrat-run/kernel@0.63.0
  - @substrat-run/adapter-sqlite@0.63.0
  - @substrat-run/adapter-cloudflare@0.63.0
  - @substrat-run/vertical-host@0.63.0
  - @substrat-run/contracts@0.63.0

## 0.6.17

### Patch Changes

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0
  - @substrat-run/adapter-cloudflare@0.62.0
  - @substrat-run/adapter-sqlite@0.62.0
  - @substrat-run/kernel@0.62.0
  - @substrat-run/vertical-host@0.62.0

## 0.6.16

### Patch Changes

- Updated dependencies [ee491fc]
  - @substrat-run/contracts@0.61.0
  - @substrat-run/adapter-cloudflare@0.61.0
  - @substrat-run/adapter-sqlite@0.61.0
  - @substrat-run/kernel@0.61.0
  - @substrat-run/vertical-host@0.61.0

## 0.6.15

### Patch Changes

- Updated dependencies [92e9e03]
- Updated dependencies [3ee5903]
  - @substrat-run/contracts@0.60.0
  - @substrat-run/adapter-cloudflare@0.60.0
  - @substrat-run/adapter-sqlite@0.60.0
  - @substrat-run/kernel@0.60.0
  - @substrat-run/vertical-host@0.60.0

## 0.6.14

### Patch Changes

- @substrat-run/contracts@0.59.0
- @substrat-run/kernel@0.59.0
- @substrat-run/adapter-sqlite@0.59.0
- @substrat-run/adapter-cloudflare@0.59.0
- @substrat-run/vertical-host@0.59.0

## 0.6.13

### Patch Changes

- Updated dependencies [daab0d5]
- Updated dependencies [778f48a]
  - @substrat-run/contracts@0.58.0
  - @substrat-run/kernel@0.58.0
  - @substrat-run/adapter-sqlite@0.58.0
  - @substrat-run/adapter-cloudflare@0.58.0
  - @substrat-run/vertical-host@0.58.0

## 0.6.12

### Patch Changes

- Updated dependencies [c9911ea]
  - @substrat-run/contracts@0.57.0
  - @substrat-run/adapter-cloudflare@0.57.0
  - @substrat-run/adapter-sqlite@0.57.0
  - @substrat-run/kernel@0.57.0
  - @substrat-run/vertical-host@0.57.0

## 0.6.11

### Patch Changes

- Updated dependencies [4eb90ca]
- Updated dependencies [1fa4bd0]
- Updated dependencies [c1faa15]
  - @substrat-run/contracts@0.56.0
  - @substrat-run/kernel@0.56.0
  - @substrat-run/adapter-cloudflare@0.56.0
  - @substrat-run/adapter-sqlite@0.56.0
  - @substrat-run/vertical-host@0.56.0

## 0.6.10

### Patch Changes

- @substrat-run/contracts@0.55.0
- @substrat-run/kernel@0.55.0
- @substrat-run/adapter-sqlite@0.55.0
- @substrat-run/adapter-cloudflare@0.55.0
- @substrat-run/vertical-host@0.55.0

## 0.6.9

### Patch Changes

- Updated dependencies [b387919]
- Updated dependencies [a16a3d4]
- Updated dependencies [6ecb3c9]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0
  - @substrat-run/kernel@0.54.0
  - @substrat-run/adapter-sqlite@0.54.0
  - @substrat-run/adapter-cloudflare@0.54.0
  - @substrat-run/vertical-host@0.54.0

## 0.6.8

### Patch Changes

- Updated dependencies [0148b77]
- Updated dependencies [88e2efa]
  - @substrat-run/adapter-cloudflare@0.53.0
  - @substrat-run/adapter-sqlite@0.53.0
  - @substrat-run/contracts@0.53.0
  - @substrat-run/kernel@0.53.0
  - @substrat-run/vertical-host@0.53.0

## 0.6.7

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0
  - @substrat-run/adapter-cloudflare@0.52.0
  - @substrat-run/adapter-sqlite@0.52.0
  - @substrat-run/kernel@0.52.0
  - @substrat-run/vertical-host@0.52.0

## 0.6.6

### Patch Changes

- @substrat-run/contracts@0.51.0
- @substrat-run/kernel@0.51.0
- @substrat-run/adapter-sqlite@0.51.0
- @substrat-run/adapter-cloudflare@0.51.0
- @substrat-run/vertical-host@0.51.0

## 0.6.5

### Patch Changes

- Updated dependencies [fa85dd8]
- Updated dependencies [0061325]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/adapter-cloudflare@0.50.0
  - @substrat-run/adapter-sqlite@0.50.0
  - @substrat-run/contracts@0.50.0
  - @substrat-run/kernel@0.50.0
  - @substrat-run/vertical-host@0.50.0

## 0.6.4

### Patch Changes

- Updated dependencies [a13c8fb]
- Updated dependencies [f11a961]
  - @substrat-run/contracts@0.49.0
  - @substrat-run/adapter-cloudflare@0.49.0
  - @substrat-run/adapter-sqlite@0.49.0
  - @substrat-run/kernel@0.49.0
  - @substrat-run/vertical-host@0.49.0

## 0.6.3

### Patch Changes

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0
  - @substrat-run/kernel@0.48.0
  - @substrat-run/adapter-sqlite@0.48.0
  - @substrat-run/adapter-cloudflare@0.48.0
  - @substrat-run/vertical-host@0.48.0

## 0.6.2

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [0e48b8f]
- Updated dependencies [3fcf34b]
  - @substrat-run/kernel@0.47.0
  - @substrat-run/adapter-sqlite@0.47.0
  - @substrat-run/adapter-cloudflare@0.47.0
  - @substrat-run/contracts@0.47.0
  - @substrat-run/vertical-host@0.47.0

## 0.6.1

### Patch Changes

- Updated dependencies [54d3d0e]
  - @substrat-run/vertical-host@0.46.0
  - @substrat-run/contracts@0.46.0
  - @substrat-run/kernel@0.46.0
  - @substrat-run/adapter-sqlite@0.46.0
  - @substrat-run/adapter-cloudflare@0.46.0

## 0.6.0

### Minor Changes

- e3f86b0: Demos are OIDC-only: remove the built-in credential store from the verticals

  Meridian, Manyfold, and Callout no longer run their own Better Auth credential
  store. They are pure OIDC relying parties — login, sign-up, password, and reset
  all live at the OIDC issuer (`demos/auth-server`). The vertical only maps the
  authenticated `sub` → a scope principal, and that binding (first-run owner-claim

  - invites in the per-tenant `IdentityDO`) is kept: it is provider-agnostic authZ,
    not credentials.

  * **meridian** — `oidcRpAuthProvider` is the sole provider; the builtin branch,
    `/api/auth-mode` split, first-run sign-up gate, dev Better-Auth store, and the
    email/password SPA are removed. Dev authenticates with the `x-principal` persona
    picker.
  * **manyfold** — gains `oidcRpAuthProvider` (it had only the bearer verifier),
    async `authProviderFor` reading the delivered `substrat:auth`; builtin removed;
    the site registry is preserved; dev on a default persona.
  * **callout** — converged onto the sandbox-clean `IdentityDO` shape: dropped the
    shared `AUTH_DB` D1 binding and Better Auth, adopted the `IdentityDO` +
    `oidcRpAuthProvider`, and replaced the TOFU auto-mint with owner-claim + invites.

  `packages/vertical-auth` is unchanged, so the production verticals that depend on
  it are unaffected. Better Auth now lives only in `demos/auth-server` (the issuer)
  and the Node-only demos (shop/rally/handlebar). Design: `docs/design/oidc-only-demos.md`.

### Patch Changes

- Updated dependencies [846af24]
  - @substrat-run/contracts@0.45.0
  - @substrat-run/adapter-sqlite@0.45.0
  - @substrat-run/adapter-cloudflare@0.45.0
  - @substrat-run/kernel@0.45.0

## 0.5.7

### Patch Changes

- Updated dependencies [3246681]
  - @substrat-run/kernel@0.44.0
  - @substrat-run/adapter-cloudflare@0.44.0
  - @substrat-run/adapter-sqlite@0.44.0
  - @substrat-run/contracts@0.44.0

## 0.5.6

### Patch Changes

- Updated dependencies [d3c0b16]
  - @substrat-run/adapter-cloudflare@0.43.0
  - @substrat-run/contracts@0.43.0
  - @substrat-run/kernel@0.43.0
  - @substrat-run/adapter-sqlite@0.43.0

## 0.5.5

### Patch Changes

- Updated dependencies [b0355b4]
- Updated dependencies [b0355b4]
  - @substrat-run/kernel@0.42.0
  - @substrat-run/adapter-sqlite@0.42.0
  - @substrat-run/adapter-cloudflare@0.42.0
  - @substrat-run/contracts@0.42.0

## 0.5.4

### Patch Changes

- Updated dependencies [e9c7bd0]
- Updated dependencies [d222905]
  - @substrat-run/adapter-cloudflare@0.41.0
  - @substrat-run/adapter-sqlite@0.41.0
  - @substrat-run/contracts@0.41.0
  - @substrat-run/kernel@0.41.0

## 0.5.3

### Patch Changes

- Updated dependencies [3a0eaa4]
- Updated dependencies [d96269e]
- Updated dependencies [3c77f64]
- Updated dependencies [d59a515]
- Updated dependencies [b82d40f]
  - @substrat-run/adapter-cloudflare@0.40.0
  - @substrat-run/kernel@0.40.0
  - @substrat-run/adapter-sqlite@0.40.0
  - @substrat-run/contracts@0.40.0

## 0.5.2

### Patch Changes

- Updated dependencies [3cf4e3b]
  - @substrat-run/contracts@0.39.0
  - @substrat-run/adapter-sqlite@0.39.0
  - @substrat-run/adapter-cloudflare@0.39.0
  - @substrat-run/kernel@0.39.0

## 0.5.1

### Patch Changes

- Updated dependencies [5afb162]
  - @substrat-run/contracts@0.38.0
  - @substrat-run/kernel@0.38.0
  - @substrat-run/adapter-sqlite@0.38.0
  - @substrat-run/adapter-cloudflare@0.38.0

## 0.5.0

### Minor Changes

- 1057d15: The demos' `package.json` `substrat` blocks now declare `entitlements` and
  `ownerGrants`, mirroring their builtin catalog entries exactly (#389). A push
  copies these onto the registry row only when present, and nothing derives them
  from `entitlementKey` — so the tenant-owned lineages' rows were landing with
  empty install-spec fields. Production installs were saved by each vertical's
  own `/internal/provision` (which grants the owner and the entitlement itself);
  embedded-mode installs would have left the owner with zero grants. With the
  declarations in place, an install of the pushed lineage carries the same SKU
  flags and day-one owner permissions as the builtin it is replacing.
- a957516: Manyfold app: finish the remaining design-handover screens (#390).

  Everything the "Manyfold CMS design system" handover specified beyond the earlier polish passes,
  all bound to real data — no mocked-up states:

  - **Field editor modal (screen 9)** — the §4 type grid with every DSL type's column mapping
    (`text→TEXT`, `bool→INT 0/1`, `ref(Type)→ULID`…), a target-type selector for refs, required/index
    toggles with their delivery consequences, and a **Stage change** primary — never "Save".
  - **Staged model editor (screen 8)** — edits stage against the live definition: NEW rows tinted
    diff-add, MODIFIED rows tinted review-amber with what changed ("index: true (was false)"),
    removed rows listed with a restore link, drag-to-reorder rows, and the staged-changes banner
    ("N STAGED CHANGES compile to 0002-post-v2 … Discard / Review migration →"). Meta-only edits
    (★ title / ⚑ slug markers, order) count as staged changes too.
  - **Migration review, diff-first (11a)** — "Review migration →" shows the generated SQL as an
    add-diff with the backfill step and the never-altered note, PENDING REVIEW badge, the admission
    checklist rail, and per-site "awaiting admission" rows; **Propose for admission** is the actual
    save.
  - **Migrations, plan-first (11b)** — per-type CREATE/BACKFILL/CUTOVER steps with expandable
    "view SQL ▾", and per-scope lazy-apply progress rows (applied / cold · applies on next open).
  - **Relationship map (10)** — deterministic force layout, curved directed edges with arrowheads
    (double-stroke refMany, dashed assetRef), edge labels, a legend, node selection with
    "Open model →", and pan/zoom contained to the canvas.
  - **Reference pickers (4a–4c)** — the modal picker for refMany (search, status filter,
    draft ⚠ / archived ⛓ warnings, create-and-link, reorderable footer chips, "Link N"), the inline
    combobox for single refs (grouped "AUTHORS IN CAFE", match highlighting, create-and-link), and
    the side drawer as the asset-library picker for assetRef fields.
  - **Markdown editor** — Write/Preview tabs with a B/I/H2/[link]/`code` toolbar and a
    dependency-free renderer, used in the entry form, the read view, and the delivery preview.
  - **Inline validation** — live maxLen errors in the danger pair ("Max 60 characters — currently
    73."), required-field errors on submit, and a slug control with a real uniqueness check against
    the site's entries plus "Re-derive from title". Tags become a chip input, enums a segmented
    control.
  - **Delivery preview (6)** — the request bar (GET pill, path, 200, ETag = content hash,
    `cache-control: public, immutable`, FROZEN REV ❄), a rendered resolved payload (blocks list with
    the red dashed unresolved row, author card) beside the raw JSON with `$unresolved` highlighted.
  - **Asset library (12)** — grid + selected-tile detail rail with USED BY computed from real entry
    bodies, and upload/replace/delete honestly disabled with reasons until the R2 connector
    (design phase 2).
  - **Members & roles (13)** — member table with pending-invite rows (wash background,
    "invite pending · sent 2d ago", Resend/Cancel), and a "Roles are per site" rail showing the
    caller's real role in every site (K-22) plus the role ladder.

### Patch Changes

- @substrat-run/contracts@0.37.0
- @substrat-run/kernel@0.37.0
- @substrat-run/adapter-sqlite@0.37.0
- @substrat-run/adapter-cloudflare@0.37.0

## 0.4.5

### Patch Changes

- Updated dependencies [b20cd82]
  - @substrat-run/vertical-auth@0.6.0
  - @substrat-run/contracts@0.36.1
  - @substrat-run/kernel@0.36.1
  - @substrat-run/adapter-sqlite@0.36.1
  - @substrat-run/adapter-cloudflare@0.36.1

## 0.4.4

### Patch Changes

- @substrat-run/contracts@0.36.0
- @substrat-run/kernel@0.36.0
- @substrat-run/adapter-sqlite@0.36.0
- @substrat-run/adapter-cloudflare@0.36.0

## 0.4.3

### Patch Changes

- Updated dependencies [17eec41]
  - @substrat-run/contracts@0.35.0
  - @substrat-run/adapter-cloudflare@0.35.0
  - @substrat-run/adapter-sqlite@0.35.0
  - @substrat-run/kernel@0.35.0

## 0.4.2

### Patch Changes

- Updated dependencies [ab637f0]
  - @substrat-run/contracts@0.34.0
  - @substrat-run/kernel@0.34.0
  - @substrat-run/adapter-sqlite@0.34.0
  - @substrat-run/adapter-cloudflare@0.34.0

## 0.4.1

### Patch Changes

- Updated dependencies [6d3429e]
  - @substrat-run/contracts@0.33.0
  - @substrat-run/kernel@0.33.0
  - @substrat-run/adapter-sqlite@0.33.0
  - @substrat-run/adapter-cloudflare@0.33.0

## 0.4.0

### Minor Changes

- 6801089: Manyfold: the dev server now uses real auth, matching the deployed worker — no impersonation anywhere.

  Previously the node dev server authenticated with an `x-principal` header (a persona-picker
  impersonation bypass) and served a dev-only `/api/personas` list, while the worker used real
  sessions (Better Auth in the per-tenant IdentityDO, or OIDC). That divergence was also the source
  of a crash: `/api/personas` doesn't exist on the worker, so on the deployed app it fell through the
  SPA catch-all and returned `index.html` with a 200; the client parsed the HTML as `{}`, turning
  `personas` into a non-array, and `personas.find(...)` threw in the entry editor.

  Now both entrypoints authenticate the same way:

  - **Dev server** runs a real Better Auth instance in node (`src/auth-node.ts`), the same
    `AuthProvider` contract the worker uses — just running in-process against its own SQLite store
    instead of a Durable Object. A session cookie → verified subject → the principal that login is
    bound to (the kernel's identity directory). The `x-principal` bypass and `/api/personas` are
    gone; `x-site` remains, as site (scope) selection, not auth. A login per cast member is seeded so
    the demo runs out of the box (credentials printed on startup), and the members view's invite flow
    (`/api/invites`, `/api/accept-invite`) is wired for real.
  - **Worker** hardens its catch-all: an unmatched `/api/*` now returns a 404 JSON instead of the SPA,
    so a missing route can never be parsed as data again.
  - **App** drops the persona picker and the dev-mode branching entirely — dev flows through the same
    sign-in screen as prod, with a Sign out control; the members view always uses the real invite
    manager.

  Adds `better-auth` as a direct dependency of the Manyfold demo (already transitively present via
  `@substrat-run/vertical-auth`).

### Patch Changes

- 5d29ff0: Domains tab: the surface field is always a picker, and Manyfold declares its surface

  Binding a hostname needs a surface, but the picker only rendered as a dropdown when the
  vertical DECLARED its surfaces (package.json `substrat.surfaces` → the registry). A vertical
  that declared none — Manyfold among them — fell back to a bare free-text box with no hint of
  what to type.

  Two changes, one per layer:

  - **Manyfold declares its surface** (`substrat.surfaces: [{ name: 'app', label: 'App' }]`) —
    the canonical source of truth. Manyfold serves one routed surface, `app`; the delivery view
    is a preview inside it, not a separately-routed surface. Reaches the dashboard picker on the
    next push to the tenant.
  - **The dashboard picker is always a dropdown.** Options are the declared surfaces when the
    vertical names them, else the surfaces already bound ∪ the conventional `app`, so an
    undeclared vertical still gets a usable menu instead of a blank box. An "Other…" option
    reveals the free-text field, keeping an undeclared surface valid — declaration is UX, not
    contract (routing.ts).

- Updated dependencies [99af6b6]
- Updated dependencies [070f4dc]
  - @substrat-run/contracts@0.32.0
  - @substrat-run/kernel@0.32.0
  - @substrat-run/adapter-sqlite@0.32.0
  - @substrat-run/adapter-cloudflare@0.32.0

## 0.3.0

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

- 77760b8: Multi-scope Manyfold, D1: an admin can request a new site (the intent producer).

  Manyfold gains a `content:manage-sites` permission (held by `admin`) and a `manyfold/request-site`
  operation: a tenant admin asks for a new site, and — since the vertical is sandbox-clean and can't
  provision a scope itself — the op enqueues a `provision-sibling` platform intent
  (platform-intents.md) via `ctx.requestPlatform`, seating the requesting admin as the new site's
  owner, and returns the request id. The platform's drain (Phases B2/C) picks it up and provisions
  the sibling.

  **Permission checkpoint:** a new key `content:manage-sites` appears in `demos/manyfold/PERMISSIONS.md`,
  granted only to `admin` — the reviewable diff for this widening.

  Scenario-tested: an admin's request enqueues a durable `provision-sibling` intent (owner = the
  admin); an author (lacking `content:manage-sites`) is denied.

  Not yet wired: the vertical's `/internal/platform-requests` endpoints (so the platform drain can
  reach these intents — needs `tenantId` threaded through the merged `VerticalClient`), the
  `POST /api/sites` route + "New site" UI, and the router kick. Those are the next D slice. Refs #358.

- 0d79662: Multi-scope Manyfold, D2: the platform can drain Manyfold's site-creation intents end-to-end.

  Wires the platform drain (Phases B2/C) to the vertical over its `/internal` surface, completing the
  loop from D1's `request-site` producer:

  - **Manyfold worker** exposes `GET /internal/platform-requests` and
    `POST /internal/platform-requests/settle` (platform-secret gated), backed by the CP-less
    `host.listPlatformRequests` / `settlePlatformRequest` (B1) — the scope's DO lives in the vertical's
    own deployment, so the platform pulls its intents from here. Plus `POST /api/sites`, which runs
    `manyfold/request-site` as the caller (its own `content:manage-sites` gate) and returns `202` + the
    request id, tagging the response with `x-substrat-platform-request` for the router kick (Phase D3).
  - **`VerticalClient.listPlatformRequests` / `settlePlatformRequest` now take `tenantId`** (the CP-less
    vertical host reads by `(tenantId, scopeId)`); `drainScopePlatformRequests` passes it from the
    drained scope's context. A small signature change to the just-added B2 methods, contained to the
    drain path.

  So a `request-site` intent is now picked up by the periodic sweep (C) and provisioned via
  `provision-sibling` (B2), appearing in the M2 site registry within a sweep cycle. The low-latency
  router kick and the "New site" UI are Phase D3. Refs #358.

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
- Updated dependencies [0e9eba7]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/vertical-auth@0.5.0
  - @substrat-run/kernel@0.31.0
  - @substrat-run/adapter-sqlite@0.31.0
  - @substrat-run/adapter-cloudflare@0.31.0

## 0.2.0

### Minor Changes

- ad4ccbf: Manyfold multi-scope, M2: a per-tenant site registry so the app lists and switches its sites.

  The per-tenant `IdentityDO` gains a site registry (`recordSite` / `listSites` /
  `resolveSiteScope`, logic factored into `site-registry.ts` so it is unit-testable without a
  Durable Object). Manyfold's worker records each site at `/internal/provision`, serves the
  tenant's sites at `GET /api/sites` (previously 404 in production, which left the switcher
  empty), and resolves the app's `x-site` slug selection to the corresponding scope in `nodeFor`
  — so the existing in-app site switcher now actually switches sites on a deployed install.
  `nodeFor` is split from a sync `baseNode` (the routed tenant + home scope, which the auth
  provider keys on) so the async site resolution never touches the auth path. Tenant isolation is
  unchanged: the registry is per-tenant and `getScope` re-checks the (tenant, scope) pair.

### Patch Changes

- Updated dependencies [ad4ccbf]
- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
- Updated dependencies [91a60e2]
  - @substrat-run/vertical-auth@0.4.0
  - @substrat-run/contracts@0.30.0
  - @substrat-run/kernel@0.30.0
  - @substrat-run/adapter-sqlite@0.30.0
  - @substrat-run/adapter-cloudflare@0.30.0

## 0.1.15

### Patch Changes

- Updated dependencies [c64bdf8]
  - @substrat-run/adapter-cloudflare@0.29.0
  - @substrat-run/vertical-auth@0.3.3
  - @substrat-run/contracts@0.29.0
  - @substrat-run/kernel@0.29.0
  - @substrat-run/adapter-sqlite@0.29.0

## 0.1.14

### Patch Changes

- Updated dependencies [d696b78]
  - @substrat-run/adapter-cloudflare@0.28.0
  - @substrat-run/vertical-auth@0.3.2
  - @substrat-run/contracts@0.28.0
  - @substrat-run/kernel@0.28.0
  - @substrat-run/adapter-sqlite@0.28.0

## 0.1.13

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0
  - @substrat-run/kernel@0.27.0
  - @substrat-run/adapter-sqlite@0.27.0
  - @substrat-run/adapter-cloudflare@0.27.0

## 0.1.12

### Patch Changes

- Updated dependencies [2bdd22b]
  - @substrat-run/contracts@0.26.0
  - @substrat-run/kernel@0.26.0
  - @substrat-run/adapter-cloudflare@0.26.0
  - @substrat-run/adapter-sqlite@0.26.0
  - @substrat-run/vertical-auth@0.3.1

## 0.1.11

### Patch Changes

- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/contracts@0.25.0
  - @substrat-run/kernel@0.25.0
  - @substrat-run/adapter-sqlite@0.25.0
  - @substrat-run/adapter-cloudflare@0.25.0

## 0.1.10

### Patch Changes

- 92d1aa1: The platform delivers a tenant's entitlements WITH provisioning, so a dispatched vertical
  projects them (#310) — completing the seam #304 left open.

  #304 projected entitlements into a scope but left the platform→dispatched-vertical path un-wired:
  a freshly provisioned CP-less scope received no entitlements, so its `entitlements_enforced` marker
  stayed off and the gate trusted upstream (only expiry, carried on the row, enforced locally).

  - **`ProvisionInstanceInput` gains `entitlements`**, delivered on the provision payload.
  - **The control-plane gathers them itself** at the single provision choke point
    (`POST /verticals/:slug/instances`) via `admin.listEntitlements` — platform-authoritative, never
    trusting the caller's body. Console and dashboard both route through that endpoint, so one
    injection covers every production path.
  - **The demo verticals (callout, meridian, manyfold)** parse `entitlements` (reusing the
    `entitlementGrant` contract) and hand them to `provisionScopeLocal`, which projects them and flips
    enforcement on.

  Propagation of a later grant/revoke to an already-live dispatched worker **rides a re-provision**
  (the idempotent K-31 call, the same channel role-definition changes use) rather than a new
  push-on-grant fan-out; expiry keeps enforcing locally meanwhile. A dedicated push channel stays
  available if a future SLA needs sub-re-provision revocation latency. Decision D-42.

- f610140: Each demo vertical's declarative surface now lives in its own crisp files instead of being
  embedded at the top of `module.ts`. Open `src/manifest.ts` and you see the _entire_ shape of
  the vertical — permission keys, id/version, events, entity relations, entitlement — with
  nothing executable to wade through; `src/module.ts` is now just operations and the
  `ModuleRegistration` wiring.

  For each of Callout, Meridian, and Manyfold:

  - **`src/manifest.ts`** — the permission-key consts (`SC_PERM`/`HR_PERM`/`MF_PERM`) **and**
    `moduleManifest.parse({...})`. The consts sit beside the manifest's `permissions` list —
    they're the same keys twice — so "add a permission" stays a single-file edit and the pair
    can't drift.
  - **`src/migrations.ts`** — the append-only `SqlMigration[]` journal (Callout's
    `boundary-lint-allow R5` extraction block moved with the migration it guards).
  - **`src/module.ts`** — imports both; holds row types, operations, and the module wiring.

  Each package gains a `./manifest` export subpath so the dashboard catalog reads a vertical's
  permission consts without dragging `seed.ts`'s `node:fs`/SQLite into the Worker bundle
  (`manifest.ts` imports only from `@substrat-run/contracts`). The `new-vertical` skill now
  scaffolds this three-file shape. Pure reorganization — no behavior, schema, or permission
  change (permission snapshots unchanged; all demo + dashboard scenario tests green).

- Updated dependencies [72b1128]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
- Updated dependencies [d4bf108]
  - @substrat-run/contracts@0.24.0
  - @substrat-run/kernel@0.24.0
  - @substrat-run/adapter-sqlite@0.24.0
  - @substrat-run/adapter-cloudflare@0.24.0
  - @substrat-run/vertical-auth@0.3.0

## 0.1.9

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/adapter-cloudflare@0.23.0
  - @substrat-run/adapter-sqlite@0.23.0
  - @substrat-run/kernel@0.23.0

## 0.1.8

### Patch Changes

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
- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0
  - @substrat-run/adapter-cloudflare@0.22.0
  - @substrat-run/adapter-sqlite@0.22.0

## 0.1.7

### Patch Changes

- Updated dependencies [3354e26]
  - @substrat-run/adapter-cloudflare@0.21.0
  - @substrat-run/contracts@0.21.0
  - @substrat-run/kernel@0.21.0
  - @substrat-run/adapter-sqlite@0.21.0

## 0.1.6

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0
  - @substrat-run/adapter-sqlite@0.20.0
  - @substrat-run/adapter-cloudflare@0.20.0

## 0.1.5

### Patch Changes

- Updated dependencies [b4a6bee]
- Updated dependencies [83aa7fd]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/adapter-cloudflare@0.19.0
  - @substrat-run/kernel@0.19.0
  - @substrat-run/adapter-sqlite@0.19.0

## 0.1.4

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0
  - @substrat-run/adapter-sqlite@0.18.0
  - @substrat-run/adapter-cloudflare@0.18.0

## 0.1.3

### Patch Changes

- @substrat-run/contracts@0.17.0
- @substrat-run/kernel@0.17.0
- @substrat-run/adapter-sqlite@0.17.0
- @substrat-run/adapter-cloudflare@0.17.0

## 0.1.2

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [b2ab362]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0
  - @substrat-run/adapter-sqlite@0.16.0
  - @substrat-run/adapter-cloudflare@0.16.0
  - @substrat-run/vertical-auth@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [cd32011]
- Updated dependencies [d93e690]
- Updated dependencies [ec89a88]
  - @substrat-run/adapter-cloudflare@0.15.0
  - @substrat-run/adapter-sqlite@0.15.0
  - @substrat-run/contracts@0.15.0
  - @substrat-run/vertical-auth@0.2.0
  - @substrat-run/kernel@0.15.0

## 0.1.0

### Minor Changes

- 21ebd1e: **Manyfold — a multi-scope headless CMS demo vertical.** A sandbox-clean, deployable vertical
  where **site = scope**: one install, many sites. The vertical owns the editorial lifecycle
  (draft→in_review→approved→published state machine that can't skip, append-only revisions,
  freeze-on-publish with a content hash, a delivery surface that resolves references — a
  draft/archived target comes back explicitly unresolved). **Content types are data**, authored
  in a model builder (`save-type`/`list-types`), each compiling to a reviewable migration
  (never a live ALTER); bodies persist as JSON so adding a field is free.

  Ships the full app: content editor + workflow, the model builder (models, field editor,
  relationship map, migration preview), and Members & roles — all URL-routed so a refresh
  restores the view. Auth is the tenant's own `IdentityDO` (Better Auth): first sign-in claims
  the owner seat (→ admin), then **member invites** (mint a principal, grant a role at scope
  level, share an accept link) open the post-setup join path. The deployable worker is
  sandbox-clean (own `ScopeDO` + `IdentityDO`, SPA inlined, no privileged bindings).

  Also fixes permission-denial status on the Cloudflare DO adapter: an op's error crosses the
  `ScopeDO` RPC boundary and is rebuilt as a plain `Error`, so `instanceof PermissionDenied`
  was false and denials degraded to 400 — now matched by message too, so denials are 403 on
  the worker as in node.

  Registers Manyfold in the dashboard catalog (`connected`) and bundles its module in the
  dashboard worker.

### Patch Changes

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0
  - @substrat-run/adapter-sqlite@0.14.0
  - @substrat-run/adapter-cloudflare@0.14.0
  - @substrat-run/kernel@0.14.0
