# @substrat-run/console

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

- f2428a9: **The Dashboard UI — the tenant-facing surface, built from the design review (docs/design/dashboard-ui.md).**

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
