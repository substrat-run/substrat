# @substrat-run/ui

## 0.3.0

### Minor Changes

- 96d1914: `useAutoRefresh` states the revalidate-and-deny contract and returns an explicit `revalidate()` (#801).

  A permission-centric app has a client-side failure of its own: **the screen outlives the
  grant.** Nothing leaks — the server refuses every subsequent action — but a person removed
  from a list while their browser sits on it keeps seeing it, for as long as nothing refetches.
  The hook is now the "re-ask" half of that, and its header names the other half a vertical's
  `load()` keeps: route a 403 into the deny state and clear the content it just refused, so the
  wall replaces the data instead of sitting above it; and wire a click on the already-selected
  nav item to `revalidate()` rather than leaving it a no-op same-route link. The scheduling
  moved to a DOM-free `startAutoRefresh` (also exported) so the contract has a test:
  nothing while hidden, one refresh per tab return, a slow poll, rejections swallowed,
  everything gone on stop.

  `demos/todo/app` and `demos/shop/app` adopt it — todo's `ListView` re-walks the same page
  depth on revalidation and drops the list when the answer is 403; shop's tabs refetch on a
  click on the open tab.

## 0.2.1

### Patch Changes

- 8a2da00: The console survives a narrow viewport, and a tenant-owned vertical's deep link resolves.

  Two defects, found together: a link to `/verticals/<tenant>/<name>` opened the verticals
  **list**, and on a small screen the version row's Vouch button — the one action that
  unblocks listing a privately-pushed vertical (#869) — could not be reached at all.

  **The deep link.** A tenant-owned vertical's slug is `<tenantSlug>/<name>` (#417), so the
  identifier carries a slash of its own. `readNav` read only the segment after the view, so
  `/verticals/acme/crm` resolved to the vertical `acme`, matched nothing, and the view fell
  back to the list with no error — the failure looked like the link had simply been ignored.
  The API layer had encoded the slug correctly all along; only the browser URL dropped it.
  Parsing now takes everything after the view (decoding per segment, so the `%2F` form lands
  on the same vertical), and the pair moves to `lib/nav.ts` as pure functions of the URL —
  testable without a DOM, which is what `test/nav.test.ts` now does.

  **The narrow viewport.** The shell had no responsive layout: the sidebar is a fixed 232px
  flex child, so at 390px it kept its full width and squeezed the content beside it to _76px_
  of usable card, while `Card` clips (`overflow: hidden`, for its rounded corners). The
  trailing buttons were not merely cramped — nothing could scroll to them. Four changes, and
  the measured content column goes 76px → 332px with no horizontal page scroll:

  - **The sidebar becomes a drawer below 900px** (`useMediaQuery`, new in `@substrat-run/ui`).
    A hamburger in the topbar opens it, a scrim or a nav selection closes it, and `visibility`
    rides the transform so a closed drawer is out of the tab order rather than off-screen and
    still focusable. Not a phone width: the squeeze starts long before the viewport is a phone.
  - **`Table` scrolls itself.** Every cell is `nowrap` (a wrapped id or timestamp is
    unreadable), so any table past a few columns is wider than a narrow card. Its own
    `overflow-x: auto` wrapper scrolls instead of the page.
  - **`Card` header actions wrap.** The row wraps, and the action group can shrink so a
    grouped set of buttons wraps within itself instead of running past the clip.
  - **`SideNav` never shrinks** (`flexShrink: 0`) and scrolls vertically — a nav rendered at a
    partial width is broken chrome that also steals the room the content needed.

  `Card`, `Table` and `SideNav` are shared with the dashboard, which gains the same behaviour;
  desktop rendering is unchanged.

## 0.2.0

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

## 0.1.2

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

## 0.1.1

### Patch Changes

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

- 3d73be3: **`Dialog` gains `confirmDisabled` — the confirm button can be gated (type-to-confirm).**

  The shared `Dialog`'s confirm button was always clickable. A destructive dialog that guards on typed input (e.g. "type the app name to confirm") could only make the click a no-op by passing `onConfirm={undefined}`, which left the button _looking_ enabled while doing nothing.

  - New `confirmDisabled?: boolean` prop disables the confirm button.
  - The button is now also disabled when there is no `onConfirm` handler at all, so a gated dialog reads correctly whichever pattern a caller uses.

  The dashboard's "Delete app" dialog uses it: the button stays disabled until the typed name matches.
