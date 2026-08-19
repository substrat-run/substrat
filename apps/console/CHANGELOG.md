# @substrat-run/console

## 0.13.11

### Patch Changes

- @substrat-run/contracts@0.76.0
- @substrat-run/kernel@0.76.0

## 0.13.10

### Patch Changes

- Updated dependencies [89c2113]
  - @substrat-run/kernel@0.75.0
  - @substrat-run/contracts@0.75.0

## 0.13.9

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0
  - @substrat-run/kernel@0.74.0

## 0.13.8

### Patch Changes

- Updated dependencies [3b8533d]
  - @substrat-run/contracts@0.73.0
  - @substrat-run/kernel@0.73.0

## 0.13.7

### Patch Changes

- Updated dependencies [f869541]
- Updated dependencies [f869541]
- Updated dependencies [19fb697]
- Updated dependencies [f869541]
- Updated dependencies [717600e]
- Updated dependencies [46b1cac]
- Updated dependencies [9208b4e]
  - @substrat-run/kernel@0.72.0
  - @substrat-run/contracts@0.72.0

## 0.13.6

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
  - @substrat-run/kernel@0.71.0

## 0.13.5

### Patch Changes

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0
  - @substrat-run/kernel@0.70.0

## 0.13.4

### Patch Changes

- Updated dependencies [17a82ec]
  - @substrat-run/contracts@0.69.0
  - @substrat-run/kernel@0.69.0

## 0.13.3

### Patch Changes

- Updated dependencies [60789c8]
- Updated dependencies [aaf41b8]
- Updated dependencies [a05cd4d]
- Updated dependencies [b9dbda9]
- Updated dependencies [4eb532b]
  - @substrat-run/contracts@0.68.0
  - @substrat-run/kernel@0.68.0

## 0.13.2

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
- Updated dependencies [ee95fd6]
  - @substrat-run/contracts@0.67.0
  - @substrat-run/kernel@0.67.0

## 0.13.1

### Patch Changes

- Updated dependencies [954668b]
  - @substrat-run/kernel@0.66.0
  - @substrat-run/contracts@0.66.0

## 0.13.0

### Minor Changes

- f151676: feat: the `builder` entitlement gates the studio + the console Members view

  Granting someone the builder studio no longer means granting them the control
  plane — and access follows the team, not an email list. The studio's gate is
  now: platform staff OR membership in a tenant holding the `builder`
  entitlement (granted per tenant in the console like any SKU; expiry applied at
  read, so a lapsed trial closes the studio). The CP's identity-tenants lookup
  returns each membership flagged with the entitlement; the studio resolves
  teams once per request, dispatches only into usable ones, and serves a proper
  HTML denied page for browsers (JSON for API callers) with a federated
  switch-account link. The studio-wide `/api/usage` rollup becomes staff-only
  (it is cross-team until metering is per-team) and the SPA hides the Usage tab
  for non-staff via a new `staff` flag on `/api/me`.

  The console's "Members" nav item graduates from Planned to a real view: the
  staff roster with grant/revoke/re-grant over new staff-gated `/api/members*`
  routes on the CP worker. Grants record the acting staff member (`added_by`,
  CP migration 0003); a re-granted staff member keeps their actor so admin-log
  history stays attributed; revoking the last active staff member is refused.
  Design record: builder-studio.md §15.

## 0.12.8

### Patch Changes

- Updated dependencies [daae585]
  - @substrat-run/contracts@0.65.0
  - @substrat-run/kernel@0.65.0

## 0.12.7

### Patch Changes

- Updated dependencies [c19e371]
  - @substrat-run/contracts@0.64.0
  - @substrat-run/kernel@0.64.0

## 0.12.6

### Patch Changes

- Updated dependencies [5e71e1c]
  - @substrat-run/kernel@0.63.0
  - @substrat-run/contracts@0.63.0

## 0.12.5

### Patch Changes

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0
  - @substrat-run/kernel@0.62.0

## 0.12.4

### Patch Changes

- Updated dependencies [ee491fc]
  - @substrat-run/contracts@0.61.0
  - @substrat-run/kernel@0.61.0

## 0.12.3

### Patch Changes

- 3ee5903: feat: outbound network policy for hosted verticals — a declared per-version allowlist, enforced at the egress worker and metered on every verdict (D-46, closes #303)

  Egress from a hosted worker runs under the platform's Cloudflare account — an
  SSRF/exfiltration and cost/abuse surface — yet every dispatched `fetch()` passed
  through the egress worker (#442) untouched, and self-serve-deploy.md §6.3 left
  the policy an explicit open question. Answered: **allowlist and metered**, with
  the allowlist being the vertical's own declaration, reviewed at the admit
  checkpoint like the permission surface.

  - **Declaration** (`contracts`): `substrat.outbound` in the vertical's
    package.json — exact lowercase hostnames plus `*.`-wildcards (any subdomain
    depth, never the apex); `outboundHost` schema, `matchesOutboundHost` matcher
    (one implementation for every seam that asks), `outbound` on the deploy
    manifest, and the list lifted onto the version record so a list view never
    parses whole manifests.
  - **CLI**: carries the declaration on push and preview, and **always** sends it
    — `[]` when undeclared, because no direct third-party egress is the correct
    default (connectors run platform-side, mail rides the `emailSender` relay,
    cross-vertical calls ride the router).
  - **Resolution** (both adapters): `readHostname`/`resolveHostname` join the
    declared list of _the version whose code the dispatch runs_ — the serving
    version when the stable serving script wins, the bound version on the
    per-version fallback — as `RouteTarget.outboundHosts`, via `json_extract` so
    the hot path stays one directory read.
  - **Router**: passes `{ slug, tenant, hosts }` as the `OUTBOUND_POLICY` outbound
    dispatch parameter (`dispatch_namespaces[].outbound.parameters`).
  - **Egress worker**: platform hosts keep looping through the router (K-27),
    declared hosts pass untouched, anything else is a 403 whose body names the
    host and says what to declare. A pre-#303 version resolves `hosts: null` and
    passes through unenforced until its next push — least privilege arrives
    version by version, never as a fleet outage. Every verdict
    (`platform`/`allowed`/`unenforced`/`refused`) writes one Analytics Engine
    datapoint (`substrat_egress`, index = slug; D-30 meter-don't-bill), so the
    unenforced tail and any refusal spike are charts, not guesses.
  - **Console**: the version table renders the declared surface beside the Admit
    button — `none`, the host list, or `undeclared (unenforced)`.

  Honest limit, published with the mechanism (self-serve-deploy.md §4.2):
  Cloudflare outbound workers do not intercept Durable-Object-originated
  subrequests, so DO-context fetches bypass enforcement today — worker-context
  egress is what is policed, and the declared list remains the reviewed contract
  for all of it. Attaching an outbound worker does disable raw TCP `connect()`
  for every dispatched script.

- Updated dependencies [92e9e03]
- Updated dependencies [3ee5903]
  - @substrat-run/contracts@0.60.0
  - @substrat-run/kernel@0.60.0

## 0.12.2

### Patch Changes

- @substrat-run/contracts@0.59.0
- @substrat-run/kernel@0.59.0

## 0.12.1

### Patch Changes

- 6e689a9: fix(console): navigation pushes history entries so Back stays in the console

  The console's URL router reflected every navigation with `replaceState` only, so
  drilling into a scope (or any other detail, or switching views) never added a
  history entry — Back left the site entirely. `writeNav` now pushes when the path
  actually changes and keeps replace for the two same-path cases: the initial mount
  (normalizing a legacy `?view=` link without adding an entry) and the reflect that
  runs after a popstate, where pushing would re-stack the entry Back just popped.
  Every navigation funnels through this one function, so sidebar switches, the
  scope/tenant/vertical drill-ins, and the cross-view jumps all get correct
  back/forward behavior at once.

- Updated dependencies [daab0d5]
- Updated dependencies [778f48a]
  - @substrat-run/contracts@0.58.0
  - @substrat-run/kernel@0.58.0

## 0.12.0

### Minor Changes

- 616c2e3: feat(console): bound scopes get bulk selection — move installs to another lineage and retire in one pass

  The vertical detail's bound-scopes list gains checkboxes with two bulk actions.
  **Move to vertical…** is the #389 update-rebind from the console: every selected
  non-fork scope rebinds onto the target lineage's serving script (data first,
  source kept as the backout), with the migration-digest acknowledgement surfaced
  as a checkbox and any refusal shown verbatim — the CLI stops being the only way
  to retire a lineage in favour of another. **Retire…** is the single-scope retire
  at selection scale (unbind hostnames → archive → reap; forks hard-deleted),
  armed by typing the count like the fleet view's destructive bulk actions. The
  fleet view's indeterminate SelectBox moves to a shared console component.

## 0.11.1

### Patch Changes

- Updated dependencies [c9911ea]
  - @substrat-run/contracts@0.57.0
  - @substrat-run/kernel@0.57.0

## 0.11.0

### Minor Changes

- fdf43bb: feat(ui,console,dashboard): the dashboard and console refresh themselves — on tab focus, and on a slow poll while visible

  Both apps needed a manual browser reload to see anything another actor did
  (an install finishing, a teammate's invite, a tenant provisioned from CI).
  Stale-while-revalidate fixes that the way react-query/SWR do by default —
  refetch on window focus plus a polling interval — inlined as a shared
  `useAutoRefresh` hook in `@substrat-run/ui`, since neither app carries a
  query library.

  - Nothing fires while the tab is hidden: a wall of backgrounded consoles must
    not poll the control plane all day. The catch-up read happens on return.
  - `focus` and `visibilitychange` both fire on tab return; a 5s minimum gap
    collapses the pair (and rapid alt-tabbing) into one refresh.
  - Background refresh errors are swallowed — no unprompted toasts; each app's
    load() keeps its own error handling.

  The console wires it to the app-level directory `load()` at 60s (each load is
  a full walk plus the per-tenant entitlements N+1), gated on auth; views derive
  from those arrays, so the refresh cascades. The dashboard composes its
  existing reloads (apps, members, deployments, catalog) at the 30s default,
  gated off in dev-mock/onboarding/invite-block states; the 5s poll while an
  install is provisioning stays.

### Patch Changes

- Updated dependencies [fdf43bb]
- Updated dependencies [4eb90ca]
- Updated dependencies [c1faa15]
  - @substrat-run/ui@0.2.0
  - @substrat-run/contracts@0.56.0
  - @substrat-run/kernel@0.56.0

## 0.10.0

### Minor Changes

- 287d9b4: feat(console): Operations → Failures — the ops-failure record gets its surface (#559)

  A new Operations section in the sidebar lists the durable ops-failure rows
  (#562's `GET /ops-failures`): time, operation · stage, vertical, tenant, status,
  and the upstream `reference = <id>` as a copy-for-CF-support affordance — the
  handle a CI log prints finally resolves to something on our side. Server-side
  narrowing by tenant, vertical, and exact reference; row click shows the full
  message.

  The vertical detail joins in: a recent-failures strip (count · latest · jump to
  the narrowed Failures view) that would have shown crm-eff's five failed restores
  at a glance, and stuck-`provisioning` bound scopes now say _why_ — "restore
  failed (CF reference …)" — by joining the failure record on scopeId, instead of
  sitting inert until the GC sweep reaps them.

### Patch Changes

- @substrat-run/contracts@0.55.0
- @substrat-run/kernel@0.55.0

## 0.9.8

### Patch Changes

- Updated dependencies [b387919]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0
  - @substrat-run/kernel@0.54.0

## 0.9.7

### Patch Changes

- Updated dependencies [0148b77]
- Updated dependencies [88e2efa]
  - @substrat-run/contracts@0.53.0
  - @substrat-run/kernel@0.53.0

## 0.9.6

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0
  - @substrat-run/kernel@0.52.0

## 0.9.5

### Patch Changes

- @substrat-run/contracts@0.51.0
- @substrat-run/kernel@0.51.0

## 0.9.4

### Patch Changes

- 3ddbbe1: feat(console,docs): make the directory backup observable (#40)

  The mechanism landed with no way to ask whether it is working, and a backup nobody has
  looked at is a belief rather than a guarantee — a cron cannot raise an alarm about its own
  absence.

  **Console → Settings → Recovery.** Freshness of the newest copy (Current / Late / Stale
  against the daily cadence), how many are held, total size, the copies themselves, and a
  **Back up now** button for the pre-migration checkpoint. An unbound store renders as the
  alarm it is — _this control plane keeps no copy of its own directory_ — which is why the
  route answers 501 rather than an empty list: "nothing held" and "nobody is looking" must
  not read alike. An overdue copy points at the sweep rather than the backup, and says so,
  because the cadence guard catches a missed tick up on the very next pass.

  Deliberately **no Restore button.** Replacing the directory has a blast radius of every
  tenant at once — past what a type-to-confirm dialog can carry — and the disaster it answers
  is one where the directory is _gone_, so a recovery path that assumes a working console is
  not there when it is needed. Restore stays a deliberate API call from the runbook, and the
  panel links to it rather than performing it.

  **Docs:** a _Backup and recovery_ section on the control-plane page — which failure each
  instrument covers (PITR for scope data, the reap copy for teardown, snapshots for a
  non-destructive copy, and the directory backup for the map itself), RPO/RTO, the rehearsed
  restore, and the honest limits (survives losing the directory, not the account; does not
  bring back the D1 staff roster, worker secrets, or sealing keys). `concepts/snapshots.md`
  already drew the "not backup/PITR" line, so it now points onward from exactly where a
  reader arrives with the question. Self-hosters get the note that matters most to them: on
  SQLite there is no PITR underneath, so this pair is not a second line of defence but the
  only one.

  The control-plane dev server binds an in-memory directory-backup store, so the Recovery tab
  is drivable locally.

- Updated dependencies [fa85dd8]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/contracts@0.50.0
  - @substrat-run/kernel@0.50.0

## 0.9.3

### Patch Changes

- Updated dependencies [a13c8fb]
- Updated dependencies [f11a961]
  - @substrat-run/contracts@0.49.0
  - @substrat-run/kernel@0.49.0

## 0.9.2

### Patch Changes

- ec55d4a: Console: give a stranded `provisioning` scope an escape hatch instead of a dead-end
  (#500, proposal 5 — the last open item after #505/#507 covered proposals 1–4).

  A scope stuck in `provisioning` (a failed migration or a dispatch gap can strand one
  indefinitely) offered _no_ lifecycle action in the scope detail view, even though the
  server permits `provisioning → archived` (`host.ts` `archiveScope`) and bulk Prune
  already relies on that edge. The client was stricter than the server, so a single
  stranded scope could not be retired from the console.

  - `availableActions('provisioning')` now returns `['archive']` — archive abandons it,
    and once archived it can be reaped. `archiving` (genuinely mid-flight) and
    `suspended-via-tenant` (the lever is the tenant, not the scope) stay action-less by
    design, each with an explanatory note.
  - The provisioning note in the scope detail view now explains the stall and that
    Archive abandons it, rather than the old "actions available when it settles" line.
  - New `fleet.test.ts` pins the console's transition graph as a **subset** of the
    server's legal transitions (so a rendered button can never 409) and locks in the
    provisioning escape hatch.

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0
  - @substrat-run/kernel@0.48.0

## 0.9.1

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [3fcf34b]
  - @substrat-run/kernel@0.47.0
  - @substrat-run/contracts@0.47.0

## 0.9.0

### Minor Changes

- 4b3c59c: Scopes view + detail: make a **serving** scope's danger visible before an operator can
  reap or archive the wrong one (#500). The mechanical guard already refuses reaping a
  bound scope (#501); this is the UX half that keeps the operator from reaching that
  refusal on a live install in the first place.

  - **A "Serving · N" badge** on every scope that resolves ≥1 hostname — in the list's
    status cell and the detail's identity grid — so a live production install no longer
    reads like the archived test cruft beside it. The detail also names the canonical
    hostname.
  - **Reap on a still-bound scope becomes an explicit "Unbind N & reap"** rather than a
    bare slug confirm that 409s: the dialog names the hostnames it will release, warns the
    app goes offline for good, and (once armed) unbinds them before wiping — the same
    order the bulk Prune lever uses.
  - **Archive now confirms through a dialog** that names the hostnames going dark, since
    archiving a serving scope is an outage (reversible, but still). A scope with no
    bindings says so and archives without friction.
  - **Bulk reap flags still-bound targets** ("serving N, will be refused") and steers to
    Prune, instead of letting the operator watch them fail one by one.

  Hostname joins reuse the fleet bindings App already loads; no new fetch. `availableActions`
  is unchanged — `provisioning` scopes have the Prune path (#505) and a cascade-suspended
  scope is explained in the detail, so neither is the silent dead-end it was.

### Patch Changes

- @substrat-run/contracts@0.46.0
- @substrat-run/kernel@0.46.0

## 0.8.0

### Minor Changes

- 280956b: Scopes view: a bulk **Prune** action for retiring dead scopes in one pass. The
  existing bulk levers only fan out lifecycle transitions, which leaves two kinds of
  scope stuck: a **snapshot fork** (has no reap transition — it is deleted, not
  reaped) and a **provisioning** scope (`availableActions` offers it nothing at all).
  Prune spans both: for every selected scope with no active app — a fork, or an
  archived/provisioning row — it releases the hostnames first (satisfying the reap
  guard), then deletes a fork outright and archives-if-needed → reaps the rest. Live
  `active` and `suspended` scopes are never included. It arms behind the same
  type-the-count gate as bulk reap (it, too, wipes storage with no restore) and lists
  every affected scope, tagged fork/status, before it fires. Each step stays its own
  audited control-plane call — no new bulk API surface.

### Patch Changes

- Updated dependencies [846af24]
  - @substrat-run/contracts@0.45.0
  - @substrat-run/kernel@0.45.0

## 0.7.0

### Minor Changes

- 9bf8c67: Scopes view: search, facet filters, real pagination, and bulk lifecycle actions.
  The fleet directory was a single "Load more" list with no way to find or act on
  scopes in bulk. It now carries a free-text search (name / slug / tenant / vertical
  / kind / id) plus Tenant, Vertical, and Jurisdiction filters, and replaces the
  "Load more" footer with client-side pagination (25/50/100 per page, prev/next,
  "showing X–Y of Z").

  Rows are selectable, with a header select-all that spans every filtered row across
  pages — so "filter to Archived → select all → reap" is one gesture. The bulk bar
  offers only the lifecycle transitions legal for at least one selected scope
  (unsuspend / restore / suspend / archive / reap), each labelled with its eligible
  count and applied only to that eligible subset. Reap — the one irreversible action
  — is armed behind a confirmation that lists the affected scopes and requires typing
  the exact count, the bulk analogue of the existing type-the-slug gate. Each bulk
  action fans out the existing per-scope endpoints, so every transition stays its own
  audited control-plane action; no new bulk API surface is added.

  Internally the view now reads the already-walked fleet directly instead of
  re-fetching a paged window (the parent already loads the whole directory via
  `walkAll`), so search and cross-page select-all operate over the full set.

### Patch Changes

- Updated dependencies [3246681]
  - @substrat-run/kernel@0.44.0
  - @substrat-run/contracts@0.44.0

## 0.6.6

### Patch Changes

- @substrat-run/contracts@0.43.0
- @substrat-run/kernel@0.43.0

## 0.6.5

### Patch Changes

- Updated dependencies [b0355b4]
- Updated dependencies [b0355b4]
  - @substrat-run/kernel@0.42.0
  - @substrat-run/contracts@0.42.0

## 0.6.4

### Patch Changes

- Updated dependencies [d222905]
  - @substrat-run/contracts@0.41.0
  - @substrat-run/kernel@0.41.0

## 0.6.3

### Patch Changes

- Updated dependencies [d96269e]
- Updated dependencies [3c77f64]
- Updated dependencies [d59a515]
  - @substrat-run/kernel@0.40.0
  - @substrat-run/contracts@0.40.0

## 0.6.2

### Patch Changes

- Updated dependencies [3cf4e3b]
  - @substrat-run/contracts@0.39.0
  - @substrat-run/kernel@0.39.0

## 0.6.1

### Patch Changes

- Updated dependencies [5afb162]
  - @substrat-run/contracts@0.38.0
  - @substrat-run/kernel@0.38.0

## 0.6.0

### Minor Changes

- 844ad13: Give the staff console the marketplace-listing surface (#389 piece 1).

  The control plane already had the staff-only `POST /verticals/:slug/listing` flip and
  builders already file publish requests (`publishRequestedAt`), but staff had no ergonomics
  for either — reviewing the queue meant curl. The Verticals view now shows a **Marketplace**
  column (listed / publish-requested-with-date / private) so the pending publish queue is
  visible from the list, and the detail card gains a **List / Unlist** action: List is the
  primary variant (it widens the audience to every tenant), Unlist is danger. The adapter's
  refusal to list while prod points at an auto-admitted version is surfaced verbatim, not
  pre-checked client-side.

### Patch Changes

- @substrat-run/contracts@0.37.0
- @substrat-run/kernel@0.37.0

## 0.5.12

### Patch Changes

- @substrat-run/contracts@0.36.0
- @substrat-run/kernel@0.36.0

## 0.5.11

### Patch Changes

- Updated dependencies [17eec41]
  - @substrat-run/contracts@0.35.0
  - @substrat-run/kernel@0.35.0

## 0.5.10

### Patch Changes

- Updated dependencies [ab637f0]
  - @substrat-run/contracts@0.34.0
  - @substrat-run/kernel@0.34.0

## 0.5.9

### Patch Changes

- Updated dependencies [6d3429e]
  - @substrat-run/contracts@0.33.0
  - @substrat-run/kernel@0.33.0

## 0.5.8

### Patch Changes

- Updated dependencies [99af6b6]
- Updated dependencies [070f4dc]
  - @substrat-run/contracts@0.32.0
  - @substrat-run/kernel@0.32.0

## 0.5.7

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
- Updated dependencies [0e9eba7]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/kernel@0.31.0

## 0.5.6

### Patch Changes

- 31cbd73: Move the running build version from the sidebar footer into Settings.

  The `v0.0.0 · <sha>` build stamp (#346) now lives under an **About** tab in Settings rather
  than as a muted footer caption. The dashboard already had a Settings page, so it gains the
  tab alongside Profile / Organization / Danger zone. The console had no Settings page, so it
  gains one: a new **Settings** nav item (under a "Console" section) opening a tabbed page
  whose first tab is About — built as a tabbed page so console-level settings have room to
  grow. Both footers drop back to just the identity/account row. A `sliders` icon was added to
  the shared `@substrat-run/ui` icon set for the console's Settings nav item (the `cog` was
  already the Permissions icon).

- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
- Updated dependencies [31cbd73]
  - @substrat-run/contracts@0.30.0
  - @substrat-run/kernel@0.30.0
  - @substrat-run/ui@0.1.2

## 0.5.5

### Patch Changes

- 1ed1cd7: Show the running build version in the dashboard and console.

  Each SPA now stamps its own package.json version and the built commit SHA into the bundle
  at build time (Vite `define`), rendered as a muted `v0.0.0 · <sha>` caption in the sidebar
  footer — so you can tell at a glance which build a given surface is serving. The SHA comes
  from `CF_PAGES_COMMIT_SHA`/`GITHUB_SHA` in CI, falling back to `git rev-parse` locally and
  `dev` when neither is available; the stamp never fails a build.

## 0.5.4

### Patch Changes

- @substrat-run/contracts@0.29.0
- @substrat-run/kernel@0.29.0

## 0.5.3

### Patch Changes

- @substrat-run/contracts@0.28.0
- @substrat-run/kernel@0.28.0

## 0.5.2

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0
  - @substrat-run/kernel@0.27.0

## 0.5.1

### Patch Changes

- Updated dependencies [2bdd22b]
  - @substrat-run/contracts@0.26.0
  - @substrat-run/kernel@0.26.0

## 0.5.0

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

### Patch Changes

- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/contracts@0.25.0
  - @substrat-run/kernel@0.25.0

## 0.4.0

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

### Patch Changes

- Updated dependencies [72b1128]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
  - @substrat-run/contracts@0.24.0
  - @substrat-run/kernel@0.24.0

## 0.3.7

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/kernel@0.23.0

## 0.3.6

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0

## 0.3.5

### Patch Changes

- @substrat-run/contracts@0.21.0
- @substrat-run/kernel@0.21.0

## 0.3.4

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0

## 0.3.3

### Patch Changes

- Updated dependencies [b4a6bee]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/kernel@0.19.0

## 0.3.2

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0

## 0.3.1

### Patch Changes

- @substrat-run/contracts@0.17.0
- @substrat-run/kernel@0.17.0

## 0.3.0

### Minor Changes

- 0caa0a9: No more local sign-in screens: a signed-out visit hands straight off to the IdP.

  Both platform apps rendered their own branded sign-in card before redirecting to
  AuthHero — an extra screen that authenticated nothing. Now the SPA redirects to
  `/api/auth/login` as soon as the session check comes back empty, preserving the
  intended destination via `returnTo`. The local card survives only as the
  `?error=auth` retry screen (auto-redirecting after a failed round-trip would loop).

  Sign-out is now always federated (`/api/auth/logout?federated`): with signed-out
  visits auto-redirecting to the IdP, a logout that left the IdP's SSO cookie alive
  would silently sign the user right back in. This also fixes the invite-mismatch
  "sign out & continue as the invited email" path, which could previously re-login
  as the wrong account.

  Deploy note: each app's origin (`https://app.substrat.net/…`,
  `https://console.substrat.net/…`) must be registered as an allowed logout URL on
  its AuthHero client — the invite flow uses dynamic `/invite/<token>` return paths,
  so a path wildcard is needed.

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0

## 0.2.0

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

- 18251a4: Make the console tab tellable from the dashboard: recolor the console favicon
  to a red/rose tonal strata (the dashboard keeps amber/cyan/indigo) and retitle
  the page `substrat.console`.
- 5860d59: Header wordmark reads substrat.console and the header glyph uses the console's rose palette, matching the favicon's privileged-surface signal.
- Updated dependencies [cd32011]
- Updated dependencies [297e057]
- Updated dependencies [ec89a88]
  - @substrat-run/contracts@0.15.0
  - @substrat-run/ui@0.1.1
  - @substrat-run/kernel@0.15.0

## 0.1.2

### Patch Changes

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0
  - @substrat-run/kernel@0.14.0

## 0.1.1

### Patch Changes

- Updated dependencies [74c9d7b]
  - @substrat-run/kernel@0.13.0
  - @substrat-run/contracts@0.13.0

## 0.1.0

### Minor Changes

- b4420fb: **Console/control-plane staff sign-in moves from per-app Better Auth to OIDC (AuthHero).**

  Second app in the platform's auth consolidation (the Dashboard was the pilot). The
  OIDC relying party is now a shared package — `@substrat-run/oidc-rp` — so the
  security-critical verifier (Authorization-Code + PKCE, ID-token/JWKS verification,
  signed session cookie; jose + Web Crypto, no `node:*`) is written once and mounted
  identically by both apps via `mountOidcRoutes`.

  - **control-plane worker**: `/api/auth/login → /callback → /logout` (+ `/session`
    for the console) replace the Better Auth handler. Staff authentication is now an
    OIDC session reduced to the provider-agnostic `StaffSessionReader` — exactly the
    seam the old code predicted. The **staff roster stays** the authorization gate
    (`staff_actor` in D1); OIDC only proves the email, so an AuthHero user who isn't
    rostered still gets nothing (fails closed). Dropped `nodejs_compat` and the
    Better Auth D1 _schema_ (the roster D1 remains). All OIDC config is secrets —
    nothing environment-specific is checked in.
  - **console SPA**: sign-in is a redirect into the OIDC flow (no password field);
    `getSession` polls `/api/auth/session`; sign-out redirects to `/api/auth/logout`.
  - The `#47` public-signup-gated-by-roster test is removed — under OIDC the control
    plane has no signup surface at all, so the hole cannot exist; a guard test asserts
    no sign-up endpoint is exposed.

  The dev harness (`control-plane-api/dev/server.mts`) keeps Better Auth for the
  optional real-auth-in-dev toggle; the primary local path is the dev actor, which is
  unaffected.

### Patch Changes

- f2428a9: **The Dashboard UI — the tenant-facing surface, built from the design review (docs/briefs/dashboard-ui.md).**

  "Vercel, for Substrat" as a real React app, on the same design system as the operator console.

  - **Shared `@substrat-run/ui`** — the design-system primitives (Button, Input, Table, SideNav,
    Dialog, tokens, `styles.css`, icons) EXTRACTED from `apps/console` into a source-only workspace
    package (no build step; the Vite apps transpile it). The console now re-exports it through a thin
    `components` barrel + `@import "@substrat-run/ui/styles.css"` — its `../components` import paths
    are unchanged, so this is an internal refactor with no behaviour change.
  - **`@substrat-run/dashboard-web`** — a new Vite + React SPA (`apps/dashboard/web`), hash-routed,
    every screen from the handoff: sign-in, onboarding, Apps grid/list, Create App (Git import /
    marketplace / CLI), App Detail (Overview + Deployments / Env Vars / Domains / Integrations /
    Settings tabs), Team + roles matrix, Domains, Integrations, Billing, Analytics, Settings, plus
    the ⌘K palette, notifications, an account menu, dark mode, and the shell. **M0 is wired** to the
    real worker API (`/api/me`, `/api/catalog`, `/api/apps`); M1–M3 + future screens run on demo data
    behind the design's honesty banners. A `VITE_DEV_MOCK` preview mode (mirroring the console's
    `VITE_DEV_ACTOR` seam) renders the demo tenant without OIDC; `?theme=`/`?menu=` aid screenshots.
  - **`@substrat-run/dashboard` worker** now **serves the SPA** as Workers static assets
    (`run_worker_first: ["/api/*"]` + `single-page-application` fallback) instead of the old inline
    page (deleted); `/api/me` also surfaces the signed-in email/name for the shell.
  - **The catalog offers a real Callout**, not just Documents. The worker bundles the Callout
    vertical's modules via a new worker-safe `@substrat-run/demo-callout/module` subpath (just
    `calloutModule` + `SC_PERM`, never the seed/auth) plus `workorder` + `invoicing`. `createApp`
    grants the three-engine SKU + the office-admin owner grants and **binds a default hostname**
    `<slug>.<jurisdiction>.substrat.run` (K-30 → `callout.global.substrat.run`), best-effort, recorded
    on the app row. M0 stand-in: production deploys Callout separately (dashboard.md §6 — router + DNS
    - ACM + control-plane `provisionInstance`), and per master-plan D-33 a demo is COPIED as a
      template, not imported.

  Verified: 4/4 dashboard scenario tests (incl. a new one provisioning a real Callout scope at
  `callout.global.substrat.run` and driving a live engine op), console + web typecheck, boundary-lint,
  builds, `wrangler --dry-run`, and a live local worker serving the SPA + returning Callout in the
  catalog.

  **Remaining (beyond this PR):** the router reading the directory, `*.substrat.run` DNS + ACM cert,
  and provisioning each app as a separate deployment via the control plane — until then a bound
  hostname is recorded but does not yet resolve.

- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
- Updated dependencies [f2428a9]
- Updated dependencies [3d73be3]
- Updated dependencies [66e752b]
- Updated dependencies [0572a3b]
  - @substrat-run/contracts@0.12.0
  - @substrat-run/ui@0.1.0
  - @substrat-run/kernel@0.12.0

## 0.0.9

### Patch Changes

- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/kernel@0.11.0
  - @substrat-run/contracts@0.11.0

## 0.0.8

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/kernel@0.10.0

## 0.0.7

### Patch Changes

- Updated dependencies [27872cc]
  - @substrat-run/kernel@0.9.0
  - @substrat-run/contracts@0.9.0

## 0.0.6

### Patch Changes

- @substrat-run/contracts@0.8.0
- @substrat-run/kernel@0.8.0

## 0.0.5

### Patch Changes

- Updated dependencies [c54637b]
- Updated dependencies [8c48c93]
- Updated dependencies [33fb5dd]
  - @substrat-run/contracts@0.7.0
  - @substrat-run/kernel@0.7.0

## 0.0.4

### Patch Changes

- @substrat-run/contracts@0.6.0
- @substrat-run/kernel@0.6.0

## 0.0.3

### Patch Changes

- @substrat-run/contracts@0.5.0
- @substrat-run/kernel@0.5.0

## 0.0.2

### Patch Changes

- Updated dependencies [6900431]
  - @substrat-run/contracts@0.4.0
  - @substrat-run/kernel@0.4.0
