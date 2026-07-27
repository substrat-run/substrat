# The Dashboard — visual UI spec

**Status:** design brief for handoff to a design tool. Companion to
[dashboard.md](dashboard.md) (the *system/authority* spec — read it first for what the
Dashboard **is**) and to the built operator console (`apps/console`), whose design system
this reuses wholesale. This document is the *screen-by-screen visual contract*: layout,
states, components, copy, and behaviour.

The one-line brief: **"Vercel, for Substrat."** A customer's tenant-admin signs up, and
from one calm, dense, keyboard-friendly surface manages their **apps** (vertical
instances), their **team**, **domains**, **integrations**, **plan**, and **analytics** —
seeing only their own tenant.

---

## 0. How to use this doc

- **Reuse, don't invent.** The visual language, tokens, and components already exist in
  `apps/console`. §1 reproduces the tokens verbatim so this file is self-contained. A
  designer should treat these as fixed constraints and design *within* them — new screens,
  same system. Do not introduce a new palette, type scale, or component family.
- **Audience contrast.** The console is an *operator* tool (all tenants, dense tables,
  back-office). The Dashboard is a *customer's home* (one tenant, warmer, more guided,
  more whitespace than the console but the same primitives). Where they share a concept
  (Domains, Members), the Dashboard view is the "my tenant" variant of the console view —
  same components, scoped data, friendlier empty states.
- **Scope markers.** Each screen is tagged **[M0]–[M3]** per dashboard.md's staged plan,
  plus **[future]** for the two screens the system spec does not yet ratify (Billing
  beyond a read-only hook, and Analytics). Design all of them; build order follows the tags.

### Milestones (from dashboard.md §6)

| | Milestone | Screens |
|---|---|---|
| **M0** | The real flow | Sign up / in, Onboarding, Overview (My Apps), Create App, App Detail (Overview) |
| **M1** | Team | Members roster, Invite, Roles |
| **M2** | Ops | App → Domains, Integrations, Environment Variables, Settings |
| **M3** | Plan | Billing (read-only entitlements) |
| **future** | — | Full Billing (invoices/payment), Analytics |

---

## 1. Design system foundations (reused from `apps/console`)

Everything here is defined in `apps/console/src/tokens/*.css` and consumed via CSS custom
properties. **Design against the token names**, not raw hex — that is what keeps light/dark
free and the two apps in lockstep.

### 1.1 Brand & identity

- **Wordmark:** `substrat`, all lowercase, `--weight-semibold`, `letter-spacing:-0.02em`.
- **Logo mark:** three stacked rounded bars = the three strata, bottom-up:
  amber (vertical) over cyan (engine) over indigo (kernel). 18×18 in the sidebar header.
  ```
  ▬ amber   (--layer-vertical #D97708)
  ▬ cyan    (--layer-engine   #0891B2)
  ▬ indigo  (--layer-kernel   #5749D8)
  ```
- **Primary brand color:** Substrat indigo, `--brand-600 #5749D8` (light) / `--brand-500`
  (dark). Used for primary actions, active nav, links, focus rings.

### 1.2 Color tokens

**Brand (indigo):** `--brand-50 #F1F2FE` · `100 #E3E5FD` · `200 #CBCEFA` · `300 #A8ABF5` ·
`400 #8683EE` · `500 #6A63E6` · `600 #5749D8` · `700 #483ABC` · `800 #3B3097` ·
`900 #322B77` · `950 #1E1947`.

**Neutrals (cool slate):** `--gray-0 #FFFFFF` · `25 #FBFBFD` · `50 #F7F8FA` · `100 #EFF1F5` ·
`200 #E3E6EC` · `300 #D1D5DE` · `400 #9CA3B2` · `500 #6B7386` · `600 #535B6E` ·
`700 #3F4657` · `800 #2A3040` · `900 #191D28` · `950 #0E1017`.

**Layer accents (use these to color-code a vertical's "kind"):**
`--layer-kernel #5749D8` · `--layer-engine #0891B2` · `--layer-vertical #D97708`.

**Semantic status:** success (green `#1F9D55`), warning (amber `#D97708`),
danger (red `#DC3D43`), info (cyan `#0891B2`), neutral (gray). Each has `-fg`, `-bg`, `-dot`
variants (e.g. `--status-success-fg/-bg/-dot`) for pills.

**Aliases you compose with** (auto-flip in dark):
`--surface-page`, `--surface-card`, `--surface-raised`, `--surface-inset`,
`--surface-hover`, `--surface-active`, `--surface-brand-subtle`;
`--text-primary/-secondary/-tertiary/-placeholder/-brand/-link`;
`--border-subtle/-default/-strong/-brand`;
`--action-primary-bg`, `--action-primary-bg-hover`, `--focus-ring`.

**Dark mode** is a `[data-theme="dark"]` attribute on the root; every alias above has a dark
value. Design **both**; the moon toggle lives in the sidebar footer.

### 1.3 Typography

- **Sans:** Geist. **Mono:** Geist Mono (ids, hostnames, env-var keys/values, code).
- **Scale (size/line-height):** xs 11/16 · sm 12.5/18 · **base 14/21** · md 16/24 ·
  lg 18/26 · xl 22/29 · 2xl 28/34 · 3xl 38/44 · 4xl 52/56.
- **Weights:** 400 / 500 / 600 / 700. **Tracking:** tight `-0.02em`, display `-0.03em`,
  caps `0.06em` (used for eyebrow/section labels in uppercase sm).
- Body default is `base` (14px). Page titles `xl`–`2xl`. Marketing-ish auth screens may go
  `3xl`.

### 1.4 Spacing, radii, sizing (4px grid, "dense ops" density)

- **Space:** 2·4·6·8·10·12·16·20·24·32·40·48·64·80·96 (`--space-05`…`--space-24`).
- **Radii:** xs 4 · sm 6 · md 8 · lg 12 · xl 16 · full 999.
- **Controls:** heights sm 28 / md 32 / lg 40. **Table row** 40. Inputs/buttons default md.
- **Layout constants:** `--sidebar-w:232px` · `--topbar-h:56px` · `--content-max-w:1200px`
  · `--prose-max-w:720px`.

### 1.5 Elevation & motion

- **Shadows:** xs/sm/md/lg + `--shadow-popover` (popovers, dialogs, dropdowns).
- **Motion:** `--ease-out cubic-bezier(0.16,1,0.3,1)` for entrances; durations
  fast 120 / base 180 / slow 280ms. Keep it restrained — this is an ops surface, not a
  landing page. Dialogs fade+rise, toasts slide from bottom-right, nothing bounces.

### 1.6 Iconography

Single-path line icons via `<SubIcon d={SubIcons.*} />`. **Existing set:**
`layers, scroll, users, cog, search, bell, box, globe, plus, moon`. The Dashboard needs a
few more in the same 24-grid, 1.5–2px stroke, rounded-join style — request these as
additions: `grid` (apps), `rocket`/`upload` (deploy), `key` (env vars/secrets),
`plug` (integrations), `creditCard` (billing), `chart` (analytics), `chevron`,
`external-link`, `copy`, `check`, `dots` (overflow menu), `clock` (activity).

### 1.7 Component inventory (already built — reuse by name)

From `apps/console/src/components`:
`Button`, `IconButton`, `Input`, `Select`, `Checkbox`, `RadioGroup`, `Switch`, `Card`,
`Badge`, `Tag`, `Table` (typed columns), `Tabs`, `KeyValue`, `Dialog`, `Toast`, `Tooltip`,
`EmptyState`, `SideNav` (sections + items with icon/label/count, header, footer),
`Breadcrumbs`, `SubIcon`.

**New components the Dashboard introduces** (build in the same style, promote to the shared
kit — see dashboard.md open-Q #5): `AppCard` (grid tile), `StatusPill` (status + dot),
`ContextSwitcher` (account menu in topbar), `CopyField` (mono value + copy button),
`KeyValueEditor` (env-var rows: key input + secret value + reveal/delete), `StatCard`
(analytics/plan tiles), `Timeline` (deploy/activity feed), `WizardSteps` (Create App).

---

## 2. App shell & global chrome

A fixed two-column shell identical in structure to `ConsoleShell`.

```
┌──────────────┬───────────────────────────────────────────────────────────┐
│  SIDEBAR     │  TOPBAR  (56px)                                            │
│  232px       │  [breadcrumbs .......................]   [⌘K][🔔][🌙][▾acct]│
│              ├───────────────────────────────────────────────────────────┤
│  ◆ substrat  │                                                           │
│              │   CONTENT                                                 │
│  Overview    │   max-width 1200 (720 for forms/prose), centered,        │
│  Apps      3 │   padding 24–32, page bg --surface-page                   │
│  Domains     │                                                           │
│  Team      4 │                                                           │
│  Integr.     │                                                           │
│  ───────     │                                                           │
│  Analytics   │                                                           │
│  Billing     │                                                           │
│  Settings    │                                                           │
│              │                                                           │
│  [footer:    │                                                           │
│   acct • 🌙] │                                                           │
└──────────────┴───────────────────────────────────────────────────────────┘
```

### 2.1 Sidebar (`SideNav`)

- **Header:** logo mark + `substrat` wordmark. Below it, the **account context** — the
  tenant name (e.g. "Acme") as a small `--text-secondary` line, so the customer always
  knows whose org they're in. (In Vercel terms this is the team; here there is exactly one
  per login for M0, so it's a label, not yet a switcher.)
- **Sections & items** (label · icon · optional count badge):
  - *(no title)* — **Overview** `grid`, **Apps** `box` (count = # apps), **Domains** `globe`,
    **Team** `users` (count = # members), **Integrations** `plug`.
  - **Account** — **Analytics** `chart`, **Billing** `creditCard`, **Settings** `cog`.
- **Active item:** `--surface-active` bg, `--text-primary`, left 2px `--brand-600` accent or
  filled indigo icon; hover `--surface-hover`.
- **Footer:** signed-in identity (avatar initial + email, truncated) with a sign-out
  affordance on hover/menu, and the **dark-mode moon toggle** (`IconButton`). Mirrors the
  console footer (`identityLabel` + `onSignOut` + `onToggleDark`).

### 2.2 Topbar (56px)

- **Left:** `Breadcrumbs` — `Acme / Apps / Acme HR / Environment Variables`. Root crumb is
  the account; each segment navigable.
- **Right, in order:** command palette trigger (`⌘K`, `search` icon — global "jump to app /
  action"), notifications `bell` (dot when unread), moon toggle (also in footer; pick one —
  recommend footer only, keep topbar for search + bell + account), and the **account menu**
  (`ContextSwitcher`): avatar + name, dropdown with *Account settings, Billing, Theme,
  Documentation, Sign out*.

### 2.3 Content region

- Centered column, `--content-max-w:1200px`. Forms and detail bodies use `--prose-max-w:720px`.
- **Page header pattern** (every screen): title (`xl`, tracking-tight) on the left, primary
  action `Button` on the right (e.g. **+ Create App**), optional one-line description in
  `--text-secondary` under the title, optional `Tabs` row beneath.

### 2.4 Cross-cutting states (define once, apply everywhere)

- **Loading:** skeleton rows/cards (shimmer using `--surface-hover`), never a bare spinner
  on full-page loads. Inline actions show a spinner inside the button.
- **Empty:** `EmptyState` — icon, one-line title, one-line helper, primary CTA. Warmer copy
  than the console (this is a customer, mid-onboarding).
- **Error:** inline `--status-danger` banner at top of the affected card with a retry;
  destructive failures also raise a `Toast`.
- **Toasts:** bottom-right, auto-dismiss ~4s, success/danger variants. Every mutation
  (create app, invite, bind domain, save env var, revoke) confirms with one.
- **Optimistic vs pending:** provisioning is genuinely async — reflect real backend status
  (`provisioning → active | failed`), do **not** fake success.

---

## 3. Data the UI renders (ground truth)

So mocks show realistic shapes, not lorem. From `apps/dashboard/src/module.ts` + worker:

- **App** (`dashboard_apps`): `name`, `vertical_slug` (catalog slug, e.g. `protocol` →
  display "Documents"), `status ∈ {provisioning, active, failed}`, `hostname` (nullable),
  `app_scope_id` (the running scope's id, ULID), `created_by` (principal), `created_at`.
- **Catalog entry:** `slug`, display `name` (M0 ships one: **Documents**), a layer/kind for
  color, short description, icon.
- **Member:** email → principal, role (M0 role = **owner**; future: admin, member,
  viewer), status (active / invited / revoked), invited-by, joined date.
- **Permissions in play:** `dashboard:provision-app` (create/manage apps — the owner),
  `dashboard:read` (read apps). The UI must **hide or disable** create/manage affordances
  for a principal lacking `provision-app`, matching the console's honesty rule: a disabled
  control explains *why* in a tooltip.
- **Domain:** hostname, bound app, verification status (pending / active), DNS record to set.
- **Integration/connection:** provider (Scrive, Fortnox…), status (connected / not), the
  secret/config it holds (never render secret values; masked).

---

## 4. Screens

Each screen below: **purpose · layout · states · components · interactions · responsive**.

---

### 4.1 Sign up / Sign in `[M0]`

**Purpose.** Self-service entry. First sign-up **bootstraps the tenant** (their org, a
dashboard scope, an owner) — so this is the single most important first impression.

**Layout.** Centered single column (~400px) on `--surface-page`, no sidebar. Logo mark +
`substrat` at top. Card (`--surface-card`, `--radius-lg`, `--shadow-sm`) containing:

- **Sign in:** email `Input`, password `Input`, **Continue** primary `Button` (full width),
  link "Create an account". (Better Auth email/password, as the verticals use.)
- **Sign up:** name, email, password; **Create account** primary; fine print "By continuing
  you agree to…". A one-line reassurance: "We'll set up your workspace automatically."
- Optional divider "or" + SSO buttons (future; leave room).

**States.** Field-level validation inline (red text under field); invalid-credentials banner
at card top; button shows spinner + disabled while submitting. **Post-sign-up transition:**
a brief "Setting up your workspace…" interstitial (provisioning the tenant) → lands on
Onboarding (§4.2), never a blank error if bootstrap is slow.

**Responsive.** Single column at all widths; card max ~400, padding shrinks on mobile.

---

### 4.2 Onboarding / empty Overview `[M0]`

**Purpose.** The just-created account has zero apps. Convert the empty state into a guided
first action (create the first app).

**Layout.** Full shell. Content is a large, friendly `EmptyState` centered in the Apps
region: `grid`/`rocket` icon, title **"Create your first app"**, helper "Apps are the
tools your team uses — pick one from the catalog to get started.", primary **+ Create App**.
Optional secondary: a compact 2–3 step checklist card ("1. Create an app · 2. Invite your
team · 3. Connect a domain") with the current step highlighted — a light onboarding nudge,
each step deep-links to the relevant screen.

**States.** Only the empty variant (populated Overview is §4.3). If bootstrap left the
account half-provisioned, show a neutral "finishing setup" note, not an error.

---

### 4.3 Overview — My Apps `[M0]`

**Purpose.** The home screen once apps exist. A projection of the tenant's scopes (excluding
the dashboard scope itself). Vercel's project grid.

**Layout.** Page header: **Apps** title + **+ Create App** primary (only if principal holds
`provision-app`; else omitted). Below, a **responsive grid of `AppCard`s**
(3 up @ ≥1024, 2 up @ ≥720, 1 up below). A toolbar above the grid: search `Input`
(filter by name), a `Select`/`Tabs` filter by status, and a **grid/list toggle**
(`IconButton`) — list mode reuses `Table`.

**`AppCard` anatomy** (`--surface-card`, `--radius-lg`, `--border-default`, hover raises to
`--shadow-md` + `--border-strong`; whole card is a link to App Detail):

```
┌───────────────────────────────────────────┐
│  �️ [layer-dot]  Acme HR            ⋯       │  name (base, semibold) + overflow menu
│  Documents · v0.0.1                        │  vertical (display name) + version, --text-secondary sm
│                                            │
│  ● Active   acme-hr.substrat.run    ↗      │  StatusPill + hostname (mono, --text-link) + external-link
│  ─────────────────────────────────────    │
│  Updated 2h ago                            │  --text-tertiary xs
└───────────────────────────────────────────┘
```

- **Left color dot / stripe** = the vertical's layer color (`--layer-*`).
- **`StatusPill`:** `provisioning` → info/amber with a subtle pulse; `active` → success;
  `failed` → danger. Dot + label, `--status-*` tokens.
- **Overflow `⋯`** (`dots`): Open, Copy URL, Rename, Settings, (danger) Delete.
- Provisioning cards are non-navigable (or navigable to a "provisioning" detail), show
  animated pill, and **poll**/live-update to `active`.

**States.** Populated grid; searching-with-no-match empty; a `failed` app surfaces a small
danger note + "Retry" on the card. **Live status** (K-realtime, when wired): pills flip
without reload.

**Responsive.** Grid collapses 3→2→1; toolbar wraps; header action becomes an icon-only
`+` on narrow.

---

### 4.4 Create App `[M0]`

**Purpose.** Catalog → provision a new scope in the tenant running the chosen vertical.
Vercel's "New Project from a template."

**Layout.** A **two-step wizard** in a `Dialog` (or a dedicated `/apps/new` page at ≥720 —
prefer page for room). `WizardSteps` header: **1 Choose · 2 Configure**.

- **Step 1 — Choose from catalog.** A grid of catalog `Card`s (same footprint as `AppCard`):
  icon in the vertical's layer color, display name (e.g. **Documents**), one-line
  description, and — crucially — **entitlement state**: if the tenant's plan doesn't include
  a vertical, the card is disabled with a `Badge` "Upgrade" and a tooltip (ties to Billing).
  Selecting a card advances. (M0 catalog has one entry; design for many.)
- **Step 2 — Configure.** Name `Input` (prefilled from the vertical, e.g. "Documents"),
  a read-only **URL preview** showing the default hostname it'll get
  (`{slug}.substrat.run`, mono, with the editable slug portion), optional environment
  `Select` (prod default; preview/staging = future scopes). Primary **Create app**.

**Interactions & async.** On submit: the app appears **immediately** in the grid with a
`provisioning` pill (the row is written before the platform effect); the scope provisions
in the background; the pill flips to `active` when `mark-app-active` lands, and the URL
becomes live. Show a `Toast` "Creating Acme HR…" then "Acme HR is ready". Never block the
whole UI on provisioning.

**States.** Catalog empty (no admitted verticals — shouldn't happen, but design a note);
name-taken validation; provisioning failure → the card shows `failed` + retry.

---

### 4.5 App Detail `[M0 overview; M2 tabs]`

**Purpose.** Everything about one app. The Vercel project page.

**Layout.** Page header: breadcrumb `Apps / Acme HR`, title = app name (inline-editable
pencil), `StatusPill`, and a primary **Visit** `Button` (opens the hostname, `external-link`)
+ overflow (Rename, Delete). Beneath: a **`Tabs`** bar:

**Overview · Data · Deployments · Previews · Settings**

Five real nouns, no more. **Environment / Domains / Integrations** are *sections inside
Settings* (`settings/environment` …) — configuration, not daily-driver surfaces, so they
don't earn top-level slots. **Previews** (né Snapshots) is the preview-and-snapshots.md
instance surface: "snapshot" stays the backend word for the exported data artifact; the
user-facing thing — a copy you visit — is a preview. Old tab URLs (`snapshots`, `env`,
`domains`, `integrations`) alias to their new homes. Only **Overview** is M0; Settings
sections are M2; **Deployments** tracks the version registry (design now, wire when
surfaced — dashboard.md open-Q #3). When the registry is real, Previews folds into
Deployments as a second section (fork-before-promote makes them one workflow); an
**Observability** tab (logs + metrics per app, observability.md) takes the freed slot,
and backups land as a section under **Data**.

#### 4.5.1 Overview tab `[M0]`

Two-column at ≥900, stacked below. Left (main): a **summary card** via `KeyValue` —
Vertical (display name + layer tag), Version, Status, Created, Created by. A **"Production"
card** showing the live hostname as a `CopyField` (mono) with Visit + Copy, and last-deploy
time. Right (rail): a compact **Activity `Timeline`** (created, activated, member added…)
sourced from the audit spine — the customer-visible slice of "every action recorded."

#### 4.5.2 Deployments tab `[future / registry-fed]`

A `Table` of registered versions bound to this app's scope: version, source (builtin/
uploaded), status (current / previous), promoted-at, by-whom. Row action **Promote** /
**Rollback** (maps to `promoteVersion`/`bindScopeVersion`). The **current** version is
badged. Empty until the registry API is surfaced — show a "Deployments will appear here"
note rather than a dead tab.

#### 4.5.3 Environment section (Settings) `[M2]`

**Purpose.** Env vars / secrets = connection secrets + module config (dashboard.md mapping).

**Layout.** A `KeyValueEditor`: rows of **Key** (`Input`, mono, UPPER_SNAKE hint) +
**Value** (`Input`, `password`-masked with a reveal `IconButton`) + **Environment** `Select`
(Production / Preview / All) + delete `IconButton`. A trailing "＋ Add" row. Bulk
**"Add from .env"** paste (`Dialog` with a textarea that parses `KEY=value` lines). Save is
explicit (**Save changes** primary, sticky footer when dirty).

**Rules.** Secret values are **never** shown by default (masked, reveal is per-row and
audited); copying a secret is allowed but toasts a reminder. Editing requires
`provision-app`; a viewer sees masked, read-only rows with a "Read-only" tag.

#### 4.5.4 Domains section (Settings) `[M2]` — see §4.7 for the shared component

The "my tenant" instance of the console's Domains view, filtered to this app: list of bound
hostnames + **Add domain** flow.

#### 4.5.5 Integrations section (Settings) `[M2]` — see §4.8

Providers this app can connect (Scrive, Fortnox…), connect/disconnect, connection status.

#### 4.5.6 Settings tab — General section `[M2]`

`KeyValue`/form: rename, the app's layer/kind (read-only), **Transfer**/ownership (future),
and a **Danger zone** card (`--status-danger` border): **Delete app** — a `Dialog`
requiring the user to type the app name to confirm (deprovisions the scope). Every
destructive action names its blast radius in plain language.

---

### 4.6 Team / Members `[M1]`

**Purpose.** Invitation *is* a grant; the roster is a projection of role assignments; revoke
tombstones. The "my tenant" variant of the console's (planned) Members view.

**Layout.** Page header **Team** + **+ Invite** primary. A `Table`:

| Member | Role | Status | Added | |
|---|---|---|---|---|
| avatar + name + email (mono) | `Select`/`Tag` (Owner / Admin / Member / Viewer) | `StatusPill` (Active / Invited / Revoked) | date | `⋯` (Change role, Resend invite, Remove) |

- **Invite `Dialog`:** email `Input` (multi-entry chips), role `Select` with a one-line
  description per role, optional per-app access (future: also grant roles inside chosen
  apps). Primary **Send invite** → creates/links a principal, grants the role, toasts,
  adds an `Invited` row.
- **Roles reference:** a collapsible card or a link to a read-only **Roles & permissions**
  matrix (role → permissions held) — mirrors `PERMISSIONS.md` §3 so the customer can see
  what each role can do. M0 ships only `owner`; design the matrix for 3–4 roles.
- **Revoke:** confirm `Dialog`; row moves to `Revoked` (tombstoned, not deleted — keep it
  visible under a "Show revoked" toggle for auditability).

**States.** Owner-only account (just you) → gentle "Invite your team" empty prompt above the
single-row table. A principal lacking invite permission sees the table read-only, **+ Invite**
disabled with an explaining tooltip.

---

### 4.7 Domains `[M2]` (account-level view + per-app tab share one component)

**Purpose.** Hostname bindings (`bindHostname`). The "my tenant" instance of the console's
`Domains.tsx`.

**Layout.** Account-level **Domains** page = a `Table` across all the tenant's apps: hostname
(mono, `--text-link`, `external-link`), bound app (link), status pill (Active /
Pending verification), added date, `⋯` (Verify, Set primary, Remove). Primary **+ Add domain**.

- **Add domain `Dialog`:** hostname `Input` → select which app it points to `Select` →
  on submit, show the **DNS instructions** step: the record to add (type/name/value in a
  `CopyField` each), a "Verify" button that re-checks, and a live status. Until verified the
  domain sits `Pending` with a "Check again" affordance.

The per-app **Domains tab** is the same `Table` pre-filtered to one app (no app column, app
preselected in Add).

**States.** No custom domains → empty state noting the default `*.substrat.run` hostname is
already live and a **Add domain** CTA. Verification-failed → inline danger + the exact
record that's missing/mismatched.

---

### 4.8 Integrations / Connections `[M2]`

**Purpose.** Connections (Scrive, Fortnox — the connection store). Vercel's Integrations.

**Layout.** Account-level **Integrations** page = a grid of provider `Card`s (logo/mono
glyph, name, one-line, and a `StatusPill` Connected / Not connected). Clicking a
not-connected provider opens a **Connect `Dialog`** (or provider-hosted flow) collecting the
credential/config; connected providers show **Manage** (edit config, view which apps use it,
Disconnect). Secrets are masked, same rules as Environment Variables (§4.5.3).

Per-app **Integrations tab** = the subset relevant/enabled for that app, with connect scoped
to the app.

**States.** Nothing connected → empty grid with the available providers as connect CTAs.

---

### 4.9 Analytics `[future]`

**Purpose.** Usage insight across the tenant's apps. *Not in the system spec yet* — this is
a forward design; keep it read-only and additive. The metrics source is now defined in
[observability.md](./observability.md): tenant-facing numbers come only from the router's
tenant-keyed Analytics Engine datapoints (script-grain Cloudflare analytics would leak other
tenants' traffic), and the screen stays "preview" until that read path is built (§3/§5
there). Long-term, this screen's audience likely wants business activity (engine events)
more than request telemetry.

**Layout.** Page header **Analytics** + a **range `Select`** (24h / 7d / 30d / custom) and
an app filter `Select` (All apps / one). Below:

- A row of **`StatCard`s**: Requests, Active users, Operations/day, Errors — each a big
  number (`2xl`), a delta vs previous period (green/red), and a sparkline.
- A primary **time-series chart** (requests or operations over time), stacked by app or by
  event kind. Use the layer accent colors as the categorical palette
  (`--layer-vertical/-engine/-kernel` + brand/cyan/amber). Follow the repo's dataviz
  conventions (light/dark aware, accessible).
- A **breakdown `Table`**: per-app rows (app, requests, users, error rate, trend).

**States.** No data yet (new account) → friendly "Data will appear as your apps get used."
Clearly label anything estimated. Since the metrics source isn't defined, mark this screen
**"preview"** in-product until wired.

---

### 4.10 Billing / Plan `[M3 read-only; future full]`

**Purpose.** M3 surfaces **entitlements read-only** (the "hook"); dashboard.md is explicit
that **billing stays out** initially. So design **two fidelities** and label them:

**M3 — Plan (read-only):**
- **Current plan `Card`:** plan name, what it includes (a `KeyValue`/list of entitlement
  flags → which verticals/features are unlocked), and any limits. A **"Contact us to change
  plan"** secondary (no self-serve checkout yet).
- **Entitlements table:** feature/vertical → included? (check/dash) → used vs limit. This is
  what gates the Create-App catalog (§4.4 upgrade badges) — keep them visually consistent.

**future — Billing (full):** payment method card, invoices `Table` (date, amount mono,
status pill, download), usage-based line items, plan-change/upgrade flow. **Design it, mark
it clearly "not yet enabled,"** and do not wire payment UI until the system spec ratifies it.

**States.** Free/default plan → the read-only plan card + "Upgrade" being an inquiry, not a
checkout, until billing is real.

---

### 4.11 Account Settings `[M0 basic → grows]`

**Purpose.** The person + the org.

**Layout.** `Tabs`: **Profile** (name, email, password change, theme, avatar initial),
**Organization** (tenant/org display name, org slug — which drives the default
`*.substrat.run` subdomain, region/jurisdiction read-only for now), **Danger zone**
(delete account — heavy confirm). Simple stacked forms in the 720 prose column, explicit
**Save**, toasts on success.

---

### 4.12 Command palette & notifications `[polish]`

- **⌘K palette:** fuzzy "jump to app", plus verbs ("Create app", "Invite member",
  "Add domain"). `--shadow-popover`, mono for ids. Optional but high-leverage for the
  "power tool" feel.
- **Notifications (`bell`):** provisioning finished/failed, invite accepted, domain
  verified, plan/limit warnings. A popover list; dot when unread.

---

## 5. Cross-cutting patterns & rules

- **Honesty over polish (inherited from the console).** Never show a control that can't act.
  If a capability isn't wired (Deployments, Analytics, full Billing), the screen **says so**
  in-place rather than faking data or 404-ing. Disabled affordances carry a tooltip naming
  the missing dependency.
- **Permission-aware UI.** Gate every create/mutate affordance on the principal's keys
  (`provision-app` for app/domain/integration/env writes; `read` for views). Viewers get
  read-only variants, not hidden nav (so the app still feels whole), with disabled primaries
  + explaining tooltips.
- **Async is real.** Provisioning, domain verification, and deploys are genuinely
  asynchronous — reflect true status (`provisioning/pending → active | failed`), poll or
  live-update, and always give a retry path on `failed`.
- **Secrets discipline.** Env-var and connection secret values are masked by default, reveal
  is per-item, copy toasts a caution. Never log/echo a secret into a toast or breadcrumb.
- **Mono for identity.** Hostnames, ids (ULIDs), env keys/values, DNS records → `--font-mono`
  with a `CopyField` wherever a user might need to copy.
- **Destructive = typed confirm.** Delete app/account/domain requires typing the resource
  name; the dialog states the blast radius in plain words.
- **One primary action per screen.** Top-right, brand-filled. Everything else is secondary/
  ghost/icon.

### 5.1 Responsive

- **≥1200:** full shell, 3-up app grid, two-column detail bodies.
- **768–1199:** sidebar persists; grids 2-up; detail bodies stack.
- **<768:** sidebar collapses to a top hamburger `Dialog`/drawer; content single-column;
  tables become stacked "cards" (label:value) where a horizontal table won't fit; primary
  actions may become icon-only or move into a bottom sticky bar.

### 5.2 Accessibility

- WCAG AA contrast (tokens are tuned for it in both themes). Visible **focus ring**
  (`--focus-ring`) on every interactive element — keyboard is a first-class path
  (this audience lives in it). All icons that carry meaning have `aria-label`; status is
  never color-only (pill always has a text label + dot). Dialogs trap focus and restore it.

### 5.3 Voice & tone

- Plain, calm, second-person. "Create your first app," "Acme HR is ready,"
  "This domain isn't verified yet." Warmer than the operator console, never cute. Error copy
  says what happened and the next step, not a stack trace. Numbers and ids stay mono and exact.

---

## 6. Deliverables to request from the design tool

1. **Foundations sheet** confirming the reused tokens (color/type/space/elevation),
   light + dark, plus the ~11 new icons in the existing line style.
2. **The new components** (§1.7): `AppCard`, `StatusPill`, `ContextSwitcher`, `CopyField`,
   `KeyValueEditor`, `StatCard`, `Timeline`, `WizardSteps` — light + dark, all states
   (default/hover/active/focus/disabled/loading).
3. **High-fidelity screens**, each in **light + dark** and at **desktop + mobile**, with
   **empty / loading / populated / error** where relevant:
   - Sign in / Sign up (+ "setting up workspace" interstitial)
   - Onboarding (empty Overview)
   - Overview / My Apps (grid + list, with a provisioning card mid-flight)
   - Create App (Step 1 catalog, Step 2 configure)
   - App Detail: Overview, Environment Variables, Domains tab, Integrations tab, Settings
     (+ Deployments and the danger-zone delete dialog)
   - Team (roster + Invite dialog + roles matrix)
   - Domains (account-level, + Add-domain DNS-verify flow)
   - Integrations (account-level grid + connect dialog)
   - Analytics (with data + empty, marked "preview")
   - Billing / Plan (M3 read-only + the "future" full-billing version, clearly labelled)
   - Account Settings
   - ⌘K palette + notifications popover
4. A **flow prototype** for the hero path: **Sign up → onboarding → Create App → app goes
   active → Visit** — the M0 walkthrough dashboard.md is built to prove.

---

*Source of truth for behaviour and scope is [dashboard.md](dashboard.md); this file governs
only the visual/UX layer. Where the two disagree, dashboard.md wins and this file is wrong —
flag it.*
