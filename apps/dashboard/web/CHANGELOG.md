# @substrat-run/dashboard-web

## 0.12.28

### Patch Changes

- Updated dependencies [96d1914]
- Updated dependencies [7843c4f]
  - @substrat-run/ui@0.3.0
  - @substrat-run/contracts@0.92.0

## 0.12.27

### Patch Changes

- Updated dependencies [75bd27c]
  - @substrat-run/contracts@0.91.0

## 0.12.26

### Patch Changes

- Updated dependencies [ec1f8e8]
- Updated dependencies [3561f7f]
  - @substrat-run/contracts@0.90.0

## 0.12.25

### Patch Changes

- Updated dependencies [c601b68]
- Updated dependencies [2352a3b]
- Updated dependencies [4f612fc]
  - @substrat-run/contracts@0.89.0

## 0.12.24

### Patch Changes

- Updated dependencies [e401927]
- Updated dependencies [04c61c1]
- Updated dependencies [d4c66ac]
- Updated dependencies [6d71731]
- Updated dependencies [1c1f23c]
- Updated dependencies [b3c362d]
  - @substrat-run/contracts@0.88.0

## 0.12.23

### Patch Changes

- Updated dependencies [b2dac1e]
  - @substrat-run/contracts@0.87.0

## 0.12.22

### Patch Changes

- @substrat-run/contracts@0.86.0

## 0.12.21

### Patch Changes

- Updated dependencies [8a2da00]
  - @substrat-run/ui@0.2.1
  - @substrat-run/contracts@0.85.0

## 0.12.20

### Patch Changes

- Updated dependencies [716a9df]
- Updated dependencies [5b7fbc0]
- Updated dependencies [946dd47]
  - @substrat-run/contracts@0.84.0

## 0.12.19

### Patch Changes

- Updated dependencies [ca3377d]
  - @substrat-run/contracts@0.83.0

## 0.12.18

### Patch Changes

- Updated dependencies [885ccf8]
- Updated dependencies [31ab573]
  - @substrat-run/contracts@0.82.0

## 0.12.17

### Patch Changes

- Updated dependencies [9cfb99d]
  - @substrat-run/contracts@0.81.0

## 0.12.16

### Patch Changes

- Updated dependencies [83b0ca3]
  - @substrat-run/contracts@0.80.0

## 0.12.15

### Patch Changes

- Updated dependencies [48ddee6]
- Updated dependencies [43d67cb]
- Updated dependencies [bb32545]
  - @substrat-run/contracts@0.79.0

## 0.12.14

### Patch Changes

- Updated dependencies [d3c6d31]
  - @substrat-run/contracts@0.78.0

## 0.12.13

### Patch Changes

- Updated dependencies [cbc4538]
  - @substrat-run/contracts@0.77.0

## 0.12.12

### Patch Changes

- @substrat-run/contracts@0.76.0

## 0.12.11

### Patch Changes

- @substrat-run/contracts@0.75.0

## 0.12.10

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0

## 0.12.9

### Patch Changes

- Updated dependencies [3b8533d]
  - @substrat-run/contracts@0.73.0

## 0.12.8

### Patch Changes

- Updated dependencies [f869541]
- Updated dependencies [19fb697]
- Updated dependencies [f869541]
- Updated dependencies [717600e]
- Updated dependencies [46b1cac]
- Updated dependencies [9208b4e]
  - @substrat-run/contracts@0.72.0

## 0.12.7

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0

## 0.12.6

### Patch Changes

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0

## 0.12.5

### Patch Changes

- Updated dependencies [17a82ec]
  - @substrat-run/contracts@0.69.0

## 0.12.4

### Patch Changes

- Updated dependencies [60789c8]
- Updated dependencies [aaf41b8]
- Updated dependencies [a05cd4d]
- Updated dependencies [b9dbda9]
  - @substrat-run/contracts@0.68.0

## 0.12.3

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
  - @substrat-run/contracts@0.67.0

## 0.12.2

### Patch Changes

- @substrat-run/contracts@0.66.0

## 0.12.1

### Patch Changes

- Updated dependencies [daae585]
  - @substrat-run/contracts@0.65.0

## 0.12.0

### Minor Changes

- c19e371: fix: a connector failure is readable, and a refused request is no longer retried for two days

  The console's card for a broken Scrive connection said, in full: `Error · scrive · Last error 7m
ago: HTTP 409 from scrive`. The real message was nine words longer and contained the whole
  answer — `Authentication to sign for participant #1 requires valid personal number field`. It
  was journaled correctly by `settlePlatformRequest` and retained; it was simply not reachable
  from anywhere a builder would look. Getting at it meant the read-only SQL console with system
  tables toggled on, or a break-glass `scope pull --full`.

  It cost a production tenant a fortnight. Three signature requests, none of which ever reached a
  counterparty: two `failed` after **100 attempts over two days**, one still `pending` at 78 and
  counting — all on the same permanent client error. The contracts sat in `pending_signature`
  throughout, and the app had nothing to tell the user.

  - **The intent journal is readable.** `_substrat_platform_requests` had one reader,
    `listPlatformRequests`, which returns only `pending` rows — so a _settled_ intent, the only
    kind that holds an answer, was invisible by construction. Its complement,
    `ScopeHost.listPlatformRequestHistory` (`kind` / `status` / `limit`, newest first), is served
    through the vertical's `/internal` surface and the control plane's new
    `GET /tenants/:t/scopes/:s/intents`, and rendered in the dashboard's integration detail as
    "Delivery attempts": id, status, attempts, timings, what was sent, and `lastError`
    **verbatim** — truncating it would rebuild the exact wall the section exists to remove.
  - **A 4xx settles terminal on the first attempt.** `pending` means _try again_, and every throw
    got it by default: right for a provider outage, wrong for a provider's refusal. A 4xx is the
    provider telling the caller its request is wrong; attempt 101 sends the identical bytes.
    `isTerminalProviderError` classifies structurally on the error's `status`, so no host imports
    a connector's error class — and 5xx, 408, 423, 425, 429 and anything with no status stay
    retryable, because a failure you cannot classify must never be settled terminally. Two days of
    silent retries becomes one settled row with the provider's own sentence on it.
  - **A terminal settle is visible to an operator.** It now lands an ops-failure row
    (`stage: 'terminal'`), the same treatment the attempt ceiling already had. A give-up and a
    refusal end the same way — nobody is coming back to the intent — so they deserve the same
    headline.
  - **A vertical can read the outcome of its own intents.** `ctx.platformRequests(filter)` is the
    read half of `ctx.requestPlatform`, which had none: an app could ask the platform to do
    something and then had no supported way to learn whether it happened. This is what lets a
    contract screen say the signing request never left, instead of showing a document that appears
    to be out for signature and is not. Read-only by construction — the kernel owns every write to
    that table.

  `ScopeHost` gained `listPlatformRequestHistory` and `OperationContext` gained
  `platformRequests`; both in-tree adapters implement them and the contract-test suite holds them.
  The 409 itself is a connector/engine gap, filed separately.

### Patch Changes

- Updated dependencies [c19e371]
  - @substrat-run/contracts@0.64.0

## 0.11.0

### Minor Changes

- 5e71e1c: fix: a plane with no seal key says so (503), instead of a bare 500 on every connect

  Saving a Scrive credential against the deployed control plane returned `500` with no usable
  detail. The cause was one line of deployment configuration: `SECRET_BOX_KEY` was unset, so the
  host fell back to the unconfigured `SecretBox` and the connection store refused to write. The
  refusal was **correct** — storing a credential unsealed is not an option — but it threw a plain
  `Error`, which no seam recognised, so it collapsed into the generic 500 handler. The operator
  saw what looked like a bug in the credential or the relay; only a worker tail (or `wrangler
secret list`) revealed a fact the process knew at boot.

  - **The relay asks first.** `HostAdmin.canStoreSecrets` reports whether the host was built with
    a box, and `relayConnectionUpsert` refuses up front with a `503` naming the missing key.
    Ahead of the pre-flight probe deliberately: a host that can never keep the answer has no
    business spending an outbound call to learn it, or handing the plaintext to the provider on
    the way.
  - **`503`, not `4xx`.** The request was well-formed and nothing about it needs correcting — it
    is the deployment that is incapable. It is also not a silent one: the refusal lands an
    ops-failure row like every other platform 5xx, so it is visible in the console rather than
    only on the screen of whoever tried to connect.
  - **Typed, so the other consumers are covered too.** The box now throws
    `SecretBoxUnconfiguredError`, and the control-plane's error boundary maps it to the same 503.
    That reaches every path a misconfigured deployment can hit — rotation, subject keys, a dump
    seal — not just the one the incident happened to come through. It is the first case of the
    typed-error fix that `mapError`'s own header has called the durable answer to matching on
    message text.
  - **The connect dialog says which thing is wrong.** A 503 now reads "this deployment can't store
    credentials right now — nothing was saved, and nothing was sent to Scrive", kept distinct from
    the provider refusing a key. A correct credential is never presented as the thing to fix.

  `HostAdmin` gained a required `canStoreSecrets`; both in-tree adapters answer it from the box
  they were constructed with.

### Patch Changes

- @substrat-run/contracts@0.63.0

## 0.10.4

### Patch Changes

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0

## 0.10.3

### Patch Changes

- Updated dependencies [ee491fc]
  - @substrat-run/contracts@0.61.0

## 0.10.2

### Patch Changes

- Updated dependencies [92e9e03]
- Updated dependencies [3ee5903]
  - @substrat-run/contracts@0.60.0

## 0.10.1

### Patch Changes

- @substrat-run/contracts@0.59.0

## 0.10.0

### Minor Changes

- 9f1078c: feat(dashboard): the team lives in the URL — every route is `/<team-slug>/…`

  Dashboard paths are now scoped to a team by their first segment
  (`app.substrat.net/acme-x1y2z3/overview`), built on the globally-unique slugs the
  worker already mints (name + ULID tail, so a slug can never shadow a section name).
  The client router pins the active slug once the session resolves and prefixes it
  onto every `navigate()` call and sidebar href — call sites keep writing `/apps/<id>`.
  Legacy slug-less paths (old bookmarks) redirect onto the pinned team; a deep link
  naming ANOTHER team you belong to switches the session before any data loads, so
  a shared `/other-team/apps/…` link opens scoped to that team with no wrong-team
  flash; an unknown slug is swapped for the pinned team's. The switcher navigates
  onto the new team's URL, and creating a team lands on `/` so the fresh load picks
  up the new slug. `/invite/…` links stay team-less by design.

### Patch Changes

- Updated dependencies [daab0d5]
- Updated dependencies [778f48a]
  - @substrat-run/contracts@0.58.0

## 0.9.0

### Minor Changes

- c9911ea: feat(contracts,cli,dashboard): the deploy workflow learns a package directory — monorepos connect nested verticals

  The generated GitHub workflow assumed the vertical is the repo root: install at
  root, `push .`, version gates on the root package.json. `DeployWorkflowOptions`
  gains `path` — pushes and previews build that directory, both version gates read
  ITS package.json, and the triggers gain an editable `paths:` filter so an
  unrelated merge does not deploy the package. Threaded through all three writers:
  `substrat init --ci github --path <dir>`, the dashboard's setup-ci and
  workflow-preview endpoints (the slug now derives from the directory basename,
  not the repo name), and a directory field in the connect form. Root spellings
  collapse to the pathless file; traversal is refused in the generator. The CLI's
  top-level errors now carry an `error:` prefix so a failure is not read as more
  wrangler chatter.

### Patch Changes

- Updated dependencies [c9911ea]
  - @substrat-run/contracts@0.57.0

## 0.8.0

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

## 0.7.0

### Minor Changes

- 8cd5039: feat(dashboard,control-plane-api): builders see their own vertical's failure history (#559)

  `GET /ops-failures` opens to builders, tenant-narrowed by the forced-filter
  pattern (`GET /scopes` precedent): a builder reads only its own tenant's rows,
  platform-level rows (null tenant) stay staff-only, and staff keep the fleet
  view. The dashboard grows the pipe — a tenant-pinned `listOpsFailures` on the
  authority seam, `GET /api/deployments/:slug/failures` (owned-slug-checked, with
  an embedded-host fallback) — and a "Recent failures" panel on the vertical
  detail: when, operation · stage, status, message, and the upstream
  `reference = <id>` with a copy affordance. A red CI run is now explainable from
  the dashboard without staff involvement; a `reference` row says "platform
  fault, here is the Cloudflare support handle", not "your code broke".

### Patch Changes

- @substrat-run/contracts@0.55.0

## 0.6.7

### Patch Changes

- Updated dependencies [b387919]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0

## 0.6.6

### Patch Changes

- Updated dependencies [0148b77]
  - @substrat-run/contracts@0.53.0

## 0.6.5

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0

## 0.6.4

### Patch Changes

- @substrat-run/contracts@0.51.0

## 0.6.3

### Patch Changes

- Updated dependencies [fa85dd8]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/contracts@0.50.0

## 0.6.2

### Patch Changes

- Updated dependencies [a13c8fb]
- Updated dependencies [f11a961]
  - @substrat-run/contracts@0.49.0

## 0.6.1

### Patch Changes

- 13f2818: Dashboard: traffic lives on the app's Observability tab only, now with a version filter.

  The Verticals page carried a fleet-wide Traffic panel that duplicated the per-app
  Observability tab — the same `observabilityMetrics` rows at a different zoom level. It's
  removed, so Verticals is purely the software you build: versions, channels, and
  publishing.

  Observability keeps traffic, reworked around a single filter bar above the list:

  - One `[Version ▾] [Range ▾] [Refresh]` bar. **Version** defaults to _All versions_ (every
    serving version of this app's vertical) and narrows the list — and, for a specific
    version, opens that version's logs below. Clicking a row is a shortcut for the same
    filter (click again to clear).
  - The version dropdown that used to be buried in the logs-panel header is gone; the panel
    now shows the active version as a tag and keeps only the log-specific level and
    message-search filters.

## 0.6.0

### Minor Changes

- 43ce1d5: Dashboard: real path routing (`/verticals`) instead of hash fragments (`/#/verticals`).

  The SPA ran on a hash router, so every route lived under `/#/…` and the per-vertical
  detail view was only reachable by hand-editing the fragment. The client now runs on the
  History API, so `app.substrat.net/verticals` and `…/verticals/<slug>` are first-class
  URLs — bookmarkable, refresh-safe, and shareable — and a vertical's detail view is a
  proper page instead of everything piling onto one screen.

  - New `lib/router.ts` `navigate()` helper: `history.pushState` + a synthetic `popstate`,
    so programmatic navigation and Back/Forward share one path. `App` re-parses
    `window.location.pathname` from a single `popstate` handler (`parsePath`, replacing
    `parseHash`). Sidebar and inline links keep a real `href` and `preventDefault()` the
    left-click, so middle-click / open-in-new-tab still work.
  - No worker changes were needed for deep links: the Workers Assets binding's
    `single-page-application` not-found handling already serves `index.html` for any
    non-`/api` path, and OIDC `returnTo` is already guarded to same-origin paths. The one
    server touch is the GitHub-connect redirect, now `/apps/new` (was `/#/apps/new`).
  - A vertical slug carrying a `/` (`acme/helpdesk`) is URI-encoded into a single path
    segment (`%2F`), which the browser and edge preserve, so it never splits across route
    parts. The legacy `/deployments` alias still resolves to Verticals.

  Verified end-to-end against the built bundle in a headless browser: `/verticals`,
  `/team`, and the encoded-slug detail link `/verticals/acme%2Fhelpdesk` each boot straight
  onto the correct page via the SPA fallback.

### Patch Changes

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0

## 0.5.17

### Patch Changes

- Updated dependencies [a90dec0]
- Updated dependencies [3fcf34b]
  - @substrat-run/contracts@0.47.0

## 0.5.16

### Patch Changes

- @substrat-run/contracts@0.46.0

## 0.5.15

### Patch Changes

- Updated dependencies [846af24]
  - @substrat-run/contracts@0.45.0

## 0.5.14

### Patch Changes

- @substrat-run/contracts@0.44.0

## 0.5.13

### Patch Changes

- @substrat-run/contracts@0.43.0

## 0.5.12

### Patch Changes

- @substrat-run/contracts@0.42.0

## 0.5.11

### Patch Changes

- Updated dependencies [d222905]
  - @substrat-run/contracts@0.41.0

## 0.5.10

### Patch Changes

- Updated dependencies [3c77f64]
- Updated dependencies [d59a515]
  - @substrat-run/contracts@0.40.0

## 0.5.9

### Patch Changes

- Updated dependencies [3cf4e3b]
  - @substrat-run/contracts@0.39.0

## 0.5.8

### Patch Changes

- Updated dependencies [5afb162]
  - @substrat-run/contracts@0.38.0

## 0.5.7

### Patch Changes

- @substrat-run/contracts@0.37.0

## 0.5.6

### Patch Changes

- @substrat-run/contracts@0.36.0

## 0.5.5

### Patch Changes

- Updated dependencies [17eec41]
  - @substrat-run/contracts@0.35.0

## 0.5.4

### Patch Changes

- Updated dependencies [ab637f0]
  - @substrat-run/contracts@0.34.0

## 0.5.3

### Patch Changes

- Updated dependencies [6d3429e]
  - @substrat-run/contracts@0.33.0

## 0.5.2

### Patch Changes

- Updated dependencies [99af6b6]
- Updated dependencies [070f4dc]
  - @substrat-run/contracts@0.32.0

## 0.5.1

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [41d01f6]
  - @substrat-run/contracts@0.31.0

## 0.5.0

### Minor Changes

- d94d0be: Multi-scope M4: a scope switcher on the app Data tab.

  The Data tab browsed only the single app scope, so a multi-scope vertical (Manyfold: one site
  per scope) showed nothing of its other scopes. It now lists the app's scopes and lets you pick
  which one's database to browse. New `GET /api/apps/:scopeId/scopes` returns the tenant's scopes
  for the app's vertical (tenant-narrowed via `TenantNarrowedControlPlane.listScopes` in connected
  mode, `host.admin.listScopes` embedded), and `DataBrowser` renders a scope `<select>` above the
  table list — shown only when an app spans more than one scope, so single-scope apps are
  unchanged. The existing table/row/query reads are keyed off the chosen scope; permissions and
  audit are untouched (they were already per-scope). Listing is a control-plane directory read —
  no vertical cooperation — while each scope's data still goes through the existing per-scope
  introspection.

### Patch Changes

- 5812c8e: Trim the Permissions tab honesty banner to one line.

  The banner at the foot of an app's Permissions tab had grown to a four-sentence paragraph
  crammed into a component built for single-line notes, so it wrapped awkwardly and repeated
  things the surrounding UI already says (the "Entity grant shapes" card header already notes
  grants are per-entity and minted at runtime; the update diff already links to the Deployments
  tab). It now keeps just the two claims worth stating — this is the declared, read-only surface,
  and role approval happens on the Deployments tab — matching the length of every other banner.

- 3aa9cde: Default custom-hostname DCV to HTTP (single-CNAME issuance).

  Cloudflare-for-SaaS certificate validation now defaults to the `http` method instead of
  `txt`. A tenant binding a custom domain publishes a **single** record — the routing CNAME —
  and Cloudflare serves the validation token at its edge once the CNAME is live, so issuance is
  hands-off (nothing for the platform to serve). The method is overridable per environment via
  `CF_SAAS_SSL_METHOD` on the control-plane worker; set it to `txt` for the previous two-record
  flow that can validate before the CNAME resolves. The dashboard's Domains preview mock is
  refreshed to the single-record shape and the `cname.substrat.run` routing target.

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
  - @substrat-run/ui@0.1.2

## 0.4.4

### Patch Changes

- 1ed1cd7: Show the running build version in the dashboard and console.

  Each SPA now stamps its own package.json version and the built commit SHA into the bundle
  at build time (Vite `define`), rendered as a muted `v0.0.0 · <sha>` caption in the sidebar
  footer — so you can tell at a glance which build a given surface is serving. The SHA comes
  from `CF_PAGES_COMMIT_SHA`/`GITHUB_SHA` in CI, falling back to `git rev-parse` locally and
  `dev` when neither is available; the stamp never fails a build.

## 0.4.3

### Patch Changes

- @substrat-run/contracts@0.29.0

## 0.4.2

### Patch Changes

- @substrat-run/contracts@0.28.0

## 0.4.1

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0

## 0.4.0

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

### Patch Changes

- Updated dependencies [2bdd22b]
  - @substrat-run/contracts@0.26.0

## 0.3.1

### Patch Changes

- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/contracts@0.25.0

## 0.3.0

### Minor Changes

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

### Patch Changes

- 5fda01e: The app Overview now lists every surface's public URL, not just the default one. A
  vertical that fronts more than one surface (K-26 — the Egeryds EKA shape) had its second
  surface's hostname reachable only from Settings → Domains; the Overview's Production card
  and the header's Visit button both hardcoded the app row's single default hostname
  (surface `app`), so the second URL was invisible on the page the dashboard links to.

  Overview reads the app's full hostname bindings (the same source the Domains tab uses)
  and renders one URL row per surface — each surface's canonical active binding, the
  default surface first, then the vertical's declared surface order — tagged with the
  surface name and label. The OpenAPI / API-docs row stays single: the API is one per app,
  surfaces are UI skins of the same vertical. The header's Visit button becomes a dropdown
  of surfaces when there is more than one, a plain button otherwise. Single-surface apps
  are unchanged, and when the hostnames endpoint isn't backed (embedded/dev) the render
  falls back to the single default hostname.

- d1022d0: Export & import moved from the Previews tab to the Data tab. It operates on the app's
  data wholesale, so Data is where a user looks for it; its only tie to Previews — the
  safety preview an import forks first — is now named in the success message ("… in the
  Previews tab") instead of relying on the list being on the same screen. The Previews
  tab refetches on open, so the explicit refresh callback is gone.
- Updated dependencies [72b1128]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
  - @substrat-run/contracts@0.24.0

## 0.2.0

### Minor Changes

- 22b1f97: Export & import from the dashboard (preview-and-snapshots.md §8's dashboard half):
  the Snapshots tab grows an Export & import card. Export downloads the app's data as
  a `.dump.json` the CLI's `scope restore` also accepts — in connected mode it arrives
  PII-masked from the control plane's governed export route (the full-fidelity
  break-glass stays a CLI/staff affordance); embedded mode returns the full read
  (`masked: false`), since the host's files already sit on the operator's own disk.
  Import replaces the app's data wholesale with an uploaded dump (a pulled export or a
  locally built world), always forking a TTL'd safety copy first so the pre-restore
  state survives as a snapshot to back out to. Both halves gate on
  `dashboard:provision-app` in the caller's own scope and land on the app's activity
  trail as `data-exported` / `data-restored` (migration 0008 widens the event CHECK,
  rebuild-and-copy like 0005/0007). New tenant-narrowed CP wrappers `exportScope` /
  `restoreScope` reach the existing staff routes over the service binding.

### Patch Changes

- 6a22014: The app Deployments tab no longer dead-ends a builder on their own vertical. The
  per-app deployments read now says whether the app's vertical is one the tenant
  pushed (`owned`, with the real `listed` flag alongside), and the tab words itself
  accordingly: for an owned private vertical the banner says promotion is self-serve
  and links to the Verticals page instead of claiming prod is a staff action (true
  only for listed/foreign verticals). When the newest admitted version isn't what
  prod points at — the exact state where no "Update to latest" can be offered — the
  Running card now explains why and links to the promote button (or names the staff
  handoff, for the non-owned case) rather than showing nothing.
- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0

## 0.1.10

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0

## 0.1.9

### Patch Changes

- @substrat-run/contracts@0.21.0

## 0.1.8

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0

## 0.1.7

### Patch Changes

- Updated dependencies [b4a6bee]
  - @substrat-run/contracts@0.19.0

## 0.1.6

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0

## 0.1.5

### Patch Changes

- @substrat-run/contracts@0.17.0

## 0.1.4

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0

## 0.1.3

### Patch Changes

- Updated dependencies [cd32011]
- Updated dependencies [297e057]
- Updated dependencies [ec89a88]
  - @substrat-run/contracts@0.15.0
  - @substrat-run/ui@0.1.1

## 0.1.2

### Patch Changes

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

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0

## 0.1.1

### Patch Changes

- Updated dependencies [74c9d7b]
  - @substrat-run/contracts@0.13.0

## 0.1.0

### Minor Changes

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

### Patch Changes

- b09b120: **Create-app URL preview shows `.global.substrat.run`, matching the real binding.**

  The Configure step previewed `<slug>.substrat.run`, but provisioning binds
  `<slug>.global.substrat.run` (K-30: `<slug>.<jurisdiction>.substrat.run`, jurisdiction
  defaults to `global`). Fixed the suffix so the preview matches what actually gets bound.

- 10b9805: **Delete app tolerates a double-click.** A fast second click re-sent `DELETE` for an
  already-deleted app → `list-apps` no longer had it → 404 "app not found" (an error
  toast, though the first delete succeeded). The handler now guards against a concurrent
  in-flight delete (an `in-flight` ref) and treats a 404 as the desired end state (already
  gone) rather than an error.
- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
- Updated dependencies [f2428a9]
- Updated dependencies [3d73be3]
- Updated dependencies [66e752b]
- Updated dependencies [0572a3b]
  - @substrat-run/contracts@0.12.0
  - @substrat-run/ui@0.1.0
