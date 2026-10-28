---
status: proposed
layer: plan
description: Evidence-based inventory of live, partial and mock portal surfaces, and gaps against the historical dashboard UI brief.
---

# Portal reality check

This is a code inventory as of 2026-10-28, not a promise of product availability. **Real** means the deployed view reads or writes its stated data through the dashboard or control-plane API. **Partly real** means a visible portion is static, an action does nothing, or a capability-dependent portion is absent. **Mock** means the displayed subject has no live read path. A read-only view can be real. A control that is deliberately disabled is called out separately.

The dashboard's `VITE_DEV_MOCK` flag selects fixture-backed preview data throughout [App.tsx](../../apps/dashboard/web/src/App.tsx) and many views; [mock.ts](../../apps/dashboard/web/src/lib/mock.ts) says deployed builds use the real session/API path. A fixture import alone therefore does **not** make a production screen mock. Conversely, [demo.ts](../../apps/dashboard/web/src/lib/demo.ts) has older comments saying post-M0 screens are placeholders; follow the actual call sites. [api.ts](../../apps/dashboard/web/src/lib/api.ts) has the same stale M0-only comment. Its handwritten methods and the [generated team client](../../apps/dashboard/web/src/lib/api.generated.ts) reach server routes. The console's `VITE_DEV_ACTOR` is a **development identity seam**, not a fixture data mode ([console App.tsx](../../apps/console/src/App.tsx)).

The tables cover routed screens and the companion views they render. “Label” reports what a user actually sees on the affected part in a deployed build. “No” means a user could reasonably read the value or control as live. “N/A” means there is no mock content to label. Links in the dependency column identify an existing decision/issue where one exists; “none” means no dependency established by this review.

## Dashboard: team level

| Screen / view | Status and evidence | Non-real part: present source → real source | Label; dependency |
|---|---|---|---|
| Sign-in and first team | **Real**, via OIDC handoff, `/api/me`, team creation, and invitation handling in [App.tsx](../../apps/dashboard/web/src/App.tsx), [SignIn.tsx](../../apps/dashboard/web/src/views/SignIn.tsx), [Onboarding.tsx](../../apps/dashboard/web/src/views/Onboarding.tsx). | The local sign-in card is only an auth-error retry; credentials live at the issuer. | N/A; [dashboard architecture](../architecture/dashboard.md). |
| Overview | **Real** app rows, fleet health, integration summary and recent audit reads; each failed read is isolated in [Overview.tsx](../../apps/dashboard/web/src/views/Overview.tsx). `VITE_DEV_MOCK` substitutes `mock-overview.ts` and `mock.ts`. | Preview fixtures → `fleetHealth`, `integrations`, `auditLogAll`; deployed path is live. | N/A in deployed mode; none. |
| Apps, empty state and fleet table | **Real** paged app list, search/status filter, create/retry/resume, install steps and health in [Apps.tsx](../../apps/dashboard/web/src/views/Apps.tsx), [FleetHealth.tsx](../../apps/dashboard/web/src/views/FleetHealth.tsx), [App.tsx](../../apps/dashboard/web/src/App.tsx). Preview uses `MOCK_APPS`/`MOCK_FLEET_HEALTH`. | Card version is blank because the app row has no version ([Apps.tsx](../../apps/dashboard/web/src/views/Apps.tsx)); version registry is separately read in app detail. | No label for blank version; none. |
| Create App | **Real** catalog, team-scoped installation and async status in [CreateApp.tsx](../../apps/dashboard/web/src/views/CreateApp.tsx), [App.tsx](../../apps/dashboard/web/src/App.tsx). `ENV_OPTS` and `verticalMeta` from `demo.ts` are display choices/labels, not catalog rows. | Preview local create → real `createApp`; deployed path is live. | N/A; none. |
| Verticals list/detail | **Real** registry, GitHub import, versions, promotion, previews, traffic, releases, issues and failures in [Verticals.tsx](../../apps/dashboard/web/src/views/Verticals.tsx). Its `MOCK_*` reads are under `DEV_MOCK`; [BoundScopes.tsx](../../apps/dashboard/web/src/views/BoundScopes.tsx) likewise uses live move/retire/review routes outside preview. | Preview fixtures → team-scoped registry/deployment APIs; deployed path is live. | N/A; none. |

## Dashboard: app level

| Screen / view | Status and evidence | Non-real part: present source → real source | Label; dependency |
|---|---|---|---|
| Header and overview | **Real** app row, hostnames, owner seat, deployment and activity reads in [AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx), [AppHeader.tsx](../../apps/dashboard/web/src/views/AppHeader.tsx). Hostname read failure falls back to the **real app row's** default hostname, not a fixture. | “More actions” dots button has no handler in `AppDetail.tsx` → existing rename/delete actions elsewhere in Settings. | No; none. |
| Peer access and cross-app events | **Real** declared/actual peer access, binding and switch controls in [AppPeers.tsx](../../apps/dashboard/web/src/views/AppPeers.tsx), and live event-edge health/replay/skip in [AppEdges.tsx](../../apps/dashboard/web/src/views/AppEdges.tsx). Both are rendered by app overview when relevant. | No fixture fallback; unreadable/absent edges are distinguished. | N/A; none. |
| Deployments and release cards | **Real** registry/deployment, release comparison, migration history, permissions/model reads and version actions in [AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx), [ReleaseCards.tsx](../../apps/dashboard/web/src/views/ReleaseCards.tsx). Preview uses `mock-deployments.ts`/`mock.ts`. | Preview fixtures → app/registry APIs; deployed path is live. | N/A; none. |
| Data: tables, schema, SQL | **Real** scope/table/page, model, field-coverage/read and audited read-only query paths in [AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx), [FieldReads.tsx](../../apps/dashboard/web/src/views/FieldReads.tsx). | Preview tables, pages and timeline targets → real scope reads. Preview SQL explicitly says “The mock preview has no live database — run against a real app.” | Labelled in preview; none. |
| Data: previews, export/import | **Real** snapshot list/create/delete and export/import in [AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx). Dev preview simulates create and says “Preview created (mock)” or “Export is not available in the preview.” | Preview fixtures → snapshot and dump APIs; deployed path is live. | Labelled in preview; [preview design](../architecture/preview-and-snapshots.md). |
| Settings: environment | **Real** declared env spec and stored values, write/delete and delivery result in [AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx). Secrets are write-only; `MOCK_APP_ENV` is dev preview only. | The historical bulk `.env` paste and per-row environment selector are absent; actual source is per-scope config, not an invented per-environment store. | N/A for data; [dashboard brief](../briefs/dashboard-ui.md). |
| Settings: domains | **Real** app hostnames, surface bindings, DNS validation and removal in [AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx). `MOCK_APP_HOSTNAMES` is preview only. | Preview fixtures → `listAppHostnames`/bind/remove/verify APIs. | N/A in deployed mode; none. |
| Settings: integrations | **Real** declared providers, connection writes, rotation, verification, activity and health in [Integrations.tsx](../../apps/dashboard/web/src/views/Integrations.tsx). `MOCK_APP_INTEGRATIONS`, activity, provider documents and probe are dev preview only. | Preview fixtures → connection-store and provider APIs. | N/A in deployed mode; [connections architecture](../architecture/connections.md). |
| Settings: members, permissions, identity and general | **Real** app member/permission, email-sender, auth-config, rename and delete routes in [AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx). | `verticalMeta` is static display metadata; no live layer/kind editing. | N/A; none. |

## Dashboard: observability and operations

| Screen / view | Status and evidence | Non-real part: present source → real source | Label; dependency |
|---|---|---|---|
| Observability hub | **Real** tenant/app filters and API-backed modes in [Observability.tsx](../../apps/dashboard/web/src/views/Observability.tsx); `mockFindingsClient` is dev preview only. | Some reads depend on plane capability and report unavailable/partial instead of substituting fixtures. | N/A; [observability RFC](../architecture/observability.md). |
| Pulse, app traffic and schedules | **Real** team/app traffic, metrics, overlays, business volumes and connector calls in [Pulse.tsx](../../apps/dashboard/web/src/views/Pulse.tsx), [AppTraffic.tsx](../../apps/dashboard/web/src/views/AppTraffic.tsx), [AppSchedules.tsx](../../apps/dashboard/web/src/views/AppSchedules.tsx), [AppSchedulesCard.tsx](../../apps/dashboard/web/src/views/AppSchedulesCard.tsx). `mock-pulse.ts`, `mock-app-traffic.ts` and `mock-schedules.ts` serve only dev preview. | Preview fixtures → tenant-keyed observability/schedule reads. Range presets are 1h/24h/3d because the plane caps these reads at 72h. | N/A in deployed mode; [observability RFC](../architecture/observability.md). |
| Requests, patterns and event lines | **Real** request volume/facets/list, log patterns, event facets and lines in [RequestsMode.tsx](../../apps/dashboard/web/src/views/RequestsMode.tsx), [PatternsMode.tsx](../../apps/dashboard/web/src/views/PatternsMode.tsx), [ObservabilityPanels.tsx](../../apps/dashboard/web/src/views/ObservabilityPanels.tsx). Dev preview uses `mock-requests.ts`, `mock-patterns.ts`, `mock-events.ts` and `mock-pulse.ts`. | Preview fixtures → observability API; deployed path is live. | N/A in deployed mode; [observability RFC](../architecture/observability.md). |
| Request/record inspection | **Real** detail, calls, entity history, causes/effects and invocation logs in [RequestSlideOver.tsx](../../apps/dashboard/web/src/views/RequestSlideOver.tsx), [RecordPanel.tsx](../../apps/dashboard/web/src/views/RecordPanel.tsx), [EventHistory.tsx](../../apps/dashboard/web/src/views/EventHistory.tsx), [InvocationStrip.tsx](../../apps/dashboard/web/src/views/InvocationStrip.tsx), [InvocationLogsStrip.tsx](../../apps/dashboard/web/src/views/InvocationLogsStrip.tsx). | `mock-request-detail.ts`/`mock-timeline.ts` run under dev preview only. Full timed waterfall remains unrecorded. | Missing timing is labelled; [#1237](https://github.com/substrat-run/substrat/issues/1237). |
| Record lifecycle | **Real** derivation from the same history entries and emitted lifecycle used by the record panel in [InstanceLifecycle.tsx](../../apps/dashboard/web/src/views/InstanceLifecycle.tsx); it flags incomplete history. | No separate fixture path; preview history comes from `mock-timeline.ts` through EventHistory. | N/A in deployed mode; none. |
| App failures | **Real** retained failure read with explicit missing/incomplete source labels in [AppFailures.tsx](../../apps/dashboard/web/src/views/AppFailures.tsx). | No fixture fallback. | N/A; none. |
| Process map and flow | **Real** process/flow, operation health and dead-letter reads in [ProcessMap.tsx](../../apps/dashboard/web/src/views/ProcessMap.tsx), [Flow.tsx](../../apps/dashboard/web/src/views/Flow.tsx). Dev preview uses `mock-processes.ts`/`mock-flow.ts`; process notes use `mockExplanations` only there. | Preview fixtures → live process, flow and explanation APIs. | N/A in deployed mode; none. |
| Findings | **Real** API-backed client in [Findings.tsx](../../apps/dashboard/web/src/views/Findings.tsx) via [Observability.tsx](../../apps/dashboard/web/src/views/Observability.tsx); `mock-findings.ts` is preview only. | Preview fixtures → team API. | N/A in deployed mode; none. |
| Audit | **Real** audit log and denial reads in [Audit.tsx](../../apps/dashboard/web/src/views/Audit.tsx); `mock-audit.ts` is preview only. | Preview fixtures → `auditLogAll` and `appDenials`. | N/A in deployed mode; none. |

## Dashboard: settings and team

| Screen / view | Status and evidence | Non-real part: present source → real source | Label; dependency |
|---|---|---|---|
| Team roster and invitations | **Partly real**. [Team.tsx](../../apps/dashboard/web/src/views/Team.tsx) renders real paged members and invite, resend, copy-link, withdraw and remove callbacks from [App.tsx](../../apps/dashboard/web/src/App.tsx). | “Roles & permissions” matrix comes from `ROLE_MATRIX` in `demo.ts`, not the current role definition/permission API. | **No** matrix warning; none. |
| Team domains | **Real** list/add/verify/remove in [Domains.tsx](../../apps/dashboard/web/src/views/Domains.tsx). `MOCK_DOMAINS` is only `DEV_MOCK`. | Preview fixtures → team domains API. | N/A in deployed mode; none. |
| Team integrations | **Real** account/provider/connection reads and writes in [Integrations.tsx](../../apps/dashboard/web/src/views/Integrations.tsx); `demo.ts` integration rows are preview only. | Preview fixtures → connection API. | N/A in deployed mode; [connections architecture](../architecture/connections.md). |
| Account settings | **Partly real**. [Settings.tsx](../../apps/dashboard/web/src/views/Settings.tsx) calls `deleteTeam` with typed confirmation; “About” uses the actual build stamp. | Organization name/slug/region and Profile fields are static/local; “Save” buttons have no handler. Real source would be account/team profile and region APIs; no matching write is used here. | **No**; can mislead. Dependency: none. |
| Notifications popover | **Mock**. [NotificationsPopover.tsx](../../apps/dashboard/web/src/components/NotificationsPopover.tsx) maps `NOTIFICATIONS` from `demo.ts`; [App.tsx](../../apps/dashboard/web/src/App.tsx) only toggles local unread state. | Static fixture → a tenant notification feed/prefs and read state; no corresponding dashboard feed exists. Audit and event sources could supply facts, but not the specified notification contract. | **No**; [#1416](https://github.com/substrat-run/substrat/issues/1416) covers tenant alerts, not this feed. |
| Command palette | **Partly real**. [App.tsx](../../apps/dashboard/web/src/App.tsx) supplies live app context and real navigation; [CommandPalette.tsx](../../apps/dashboard/web/src/components/CommandPalette.tsx) handles actions. | `mockAsk` is only dev preview. Availability of model-backed Ask depends on the configured service; the palette itself is usable. | N/A for preview; none. |

## Dashboard: billing

| Screen / view | Status and evidence | Non-real part: present source → real source | Label; dependency |
|---|---|---|---|
| Plan card and entitlements | **Mock**. [Billing.tsx](../../apps/dashboard/web/src/views/Billing.tsx) hardcodes “Team”, inclusions, app/member limits and maps `ENTITLEMENTS` from `demo.ts`; “Contact us to change plan” has no handler. | `demo.ts` → tenant entitlements/plan and usage reads. Real entitlements exist in the directory and the staff [Meters view](../../apps/console/src/views/Meters.tsx); this page makes no API call. | Only “Self-serve plan changes aren’t enabled yet”; **not** a warning that plan/usage figures are samples. [#39](https://github.com/substrat-run/substrat/issues/39), [D-30](../decisions/D-030-control-plane-the-shared-layer-across-n-per-vertical-deploym.md). |
| Payment method, current period and invoices | **Mock, design ahead**. [Billing.tsx](../../apps/dashboard/web/src/views/Billing.tsx) hardcodes a card and period amount and maps `INVOICES` from `demo.ts` into paid rows with download icons but no download action. | Fixtures → **no** platform pricing, invoice, payment or dunning system exists. The domain [invoicing engine](../../engines/invoicing) is for a vertical's own business, not platform billing. | **Yes:** “Not yet enabled” and “Payments aren’t wired yet — plan changes go through us. This shows the intended shape.” [#39](https://github.com/substrat-run/substrat/issues/39), [D-30](../decisions/D-030-control-plane-the-shared-layer-across-n-per-vertical-deploym.md). |

The first honest billing-adjacent screen could display **unpriced, per-tenant metered usage**: the stored storage/attachment gauge ([#1524](https://github.com/substrat-run/substrat/issues/1524)), estimated daily router request counts ([#2501](https://github.com/substrat-run/substrat/issues/2501)), and the model-usage ledger/summary ([control-plane API](../../packages/control-plane-api/src/api.ts)). [#2501](https://github.com/substrat-run/substrat/issues/2501) is closed after the capture work. These are staff-facing reads today, so a tenant-scoped read and clear coverage/staleness labels would be needed in the dashboard. Meter 1/2 snapshots and ownership history are also captured; none implies a price. [engine-metering](../../engines/metering/src/index.ts) is a **separate vertical-composed usage ledger**; the ticket0 vertical composes it and reads `usageTotal` in [its module](../../demos/ticket0/src/module.ts). It does not back this page or create a platform invoice. [#39](https://github.com/substrat-run/substrat/issues/39) was closed with “meter, don't bill”; pricing, invoices, payment rail and dunning await a commercial decision.

## Staff console

The console routes are enumerated in [ConsoleShell.tsx](../../apps/console/src/ConsoleShell.tsx) and wired in [App.tsx](../../apps/console/src/App.tsx). It has no `demo.ts`/`mock-*` data fallback in its views. An unconfigured capability yields an empty/error state, not a green fixture. The table includes every `views/*.tsx` file; smaller files are named with their parent route.

| Screen / view | Status and evidence | Non-real part: present source → real source | Label; dependency |
|---|---|---|---|
| Login | **Real** staff session/SSO in [Login.tsx](../../apps/console/src/views/Login.tsx), [App.tsx](../../apps/console/src/App.tsx). | Dev actor header is development auth, not mock data. | N/A; none. |
| Tenants and TenantDetail | **Real** paged tenant list, create, status, entitlements and reaping via [Tenants.tsx](../../apps/console/src/views/Tenants.tsx), [TenantDetail.tsx](../../apps/console/src/views/TenantDetail.tsx). | None. | N/A; none. |
| Scopes, ScopeDetail, CreateInstance, StorageCard | **Real** scope lifecycle, version/hostname reads, instance creation and storage gauge in [Scopes.tsx](../../apps/console/src/views/Scopes.tsx), [ScopeDetail.tsx](../../apps/console/src/views/ScopeDetail.tsx), [CreateInstance.tsx](../../apps/console/src/views/CreateInstance.tsx), [StorageCard.tsx](../../apps/console/src/views/StorageCard.tsx). | Storage may be unsampled/stale; the view labels coverage rather than inventing a total. | Labelled; [#1524](https://github.com/substrat-run/substrat/issues/1524). |
| Domains | **Real** hostname list/bind/status changes in [Domains.tsx](../../apps/console/src/views/Domains.tsx). | None. | N/A; none. |
| Verticals and VerticalDetail | **Real** registry, versions, admission, channels, promotion, scope moves and capability controls in [Verticals.tsx](../../apps/console/src/views/Verticals.tsx), [VerticalDetail.tsx](../../apps/console/src/views/VerticalDetail.tsx). | Missing migration SQL is explicitly “not available”, not presented as empty. | Labelled; none. |
| Observability, ConnectorCallsChart | **Partly real**: [Observability.tsx](../../apps/console/src/views/Observability.tsx) and [ConnectorCallsChart.tsx](../../apps/console/src/views/ConnectorCallsChart.tsx) call live service metrics/log APIs. | The plane may lack an observability reader; there is no fixture fallback. | “Observability is not configured”; [observability RFC](../architecture/observability.md). |
| Meters | **Partly real**: [Meters.tsx](../../apps/console/src/views/Meters.tsx) reads live meter 1/2, storage and model usage. | Cross-tenant order/read meter is unavailable; no invented number. | Missing meters are stated in-view; [D-30](../decisions/D-030-control-plane-the-shared-layer-across-n-per-vertical-deploym.md). |
| AdminLog | **Real** paged admin records in [AdminLog.tsx](../../apps/console/src/views/AdminLog.tsx). | None. | N/A; none. |
| Permissions | **Partly real**: [Permissions.tsx](../../apps/console/src/views/Permissions.tsx) reads roles and admin log. | Per-principal grant enumeration does not exist; view calls it a gap, not mock data. | Labelled; none. |
| Members | **Real** staff roster and grant/revoke in [Members.tsx](../../apps/console/src/views/Members.tsx). | None. | N/A; none. |
| OpsFailures and Issues | **Real** failure ledger and issue status APIs in [OpsFailures.tsx](../../apps/console/src/views/OpsFailures.tsx), [Issues.tsx](../../apps/console/src/views/Issues.tsx). | None. | N/A; none. |
| SweepRuns | **Real** sweep history API in [SweepRuns.tsx](../../apps/console/src/views/SweepRuns.tsx). | None. | N/A; none. |
| ConnectionsHealth | **Real** connection health API in [ConnectionsHealth.tsx](../../apps/console/src/views/ConnectionsHealth.tsx). | None. | N/A; none. |
| Services | **Partly real**: [Services.tsx](../../apps/console/src/views/Services.tsx) reads switches, sweeps, connections, backlog and metrics. | A missing metric/capability becomes “not configured on this control plane” or “unavailable”; no fixture fallback. | Labelled; none. |
| Settings | **Real** directory-backup list/create in [Settings.tsx](../../apps/console/src/views/Settings.tsx). | None. | N/A; none. |

## Gap analysis against the historical dashboard UI brief

This comparison follows [dashboard-ui.md](../briefs/dashboard-ui.md) §1–5 in order. **Built** means the specified behavior is present (the data may still be mock, as the inventory above says). **Built differently** names a deliberate or observed deviation. **Mock only** means the designed UI exists with fixtures/local state but no live subject. **Not built** means no equivalent UI/behavior was found. The historical brief is a visual contract, while [dashboard.md](../architecture/dashboard.md) and later [observability.md](../architecture/observability.md) govern authority and telemetry. Milestone tags are the brief's, including `[polish]` and `[future]`; they are not a claim that a milestone is still open.

### §1 Foundations and components

| Tag | Designed item | Result and evidence |
|---|---|---|
| cross-cutting | Console token palette, light/dark, Geist, spacing/radius/elevation/motion | **Built** using shared [UI package](../../packages/ui) and dashboard [styles](../../apps/dashboard/web/src). |
| cross-cutting | Wordmark, three-strata mark, layer accents and extended line-icon set | **Built** in [icons.tsx](../../apps/dashboard/web/src/lib/icons.tsx) and [DashShell.tsx](../../apps/dashboard/web/src/components/DashShell.tsx). |
| cross-cutting | Reuse console primitives (Button, Input, Tabs, Dialog, Toast, etc.) | **Built differently**: dashboard imports the shared `@substrat-run/ui` kit rather than console-local components; see [Billing.tsx](../../apps/dashboard/web/src/views/Billing.tsx). |
| cross-cutting | `AppCard`, `StatusPill`, `ContextSwitcher`, `CopyField`, `KeyValueEditor`, `StatCard`, `Timeline`, `WizardSteps` promoted to shared kit | **Built differently**: [AppCard.tsx](../../apps/dashboard/web/src/components/AppCard.tsx), local `Pill`/layout helpers and inline timeline/stepper cover the main UI; there is no complete named shared set, and the env editor is server-spec driven rather than the brief's generic editor. |

### §2 Shell and global states

| Tag | Designed item | Result and evidence |
|---|---|---|
| cross-cutting | Fixed sidebar/topbar, account context, section nav and dark toggle | **Built differently**: [DashShell.tsx](../../apps/dashboard/web/src/components/DashShell.tsx) has Build/Operate/Configure sections, team switching and more routes than the brief's single-account nav. |
| cross-cutting | Breadcrumbs and account menu with Settings/Billing/Theme/Docs/Sign out | **Built differently**: breadcrumbs, team switcher and identity menu exist in [DashShell.tsx](../../apps/dashboard/web/src/components/DashShell.tsx), with current navigation/copy rather than the exact proposed menu. |
| `[polish]` | Topbar `⌘K` search/action trigger | **Built** in [DashShell.tsx](../../apps/dashboard/web/src/components/DashShell.tsx) and [CommandPalette.tsx](../../apps/dashboard/web/src/components/CommandPalette.tsx). |
| `[polish]` | Notification bell, unread dot and popover | **Mock only**: popover rows use `demo.ts` and unread is local state ([NotificationsPopover.tsx](../../apps/dashboard/web/src/components/NotificationsPopover.tsx), [App.tsx](../../apps/dashboard/web/src/App.tsx)). |
| cross-cutting | Centered content widths and page headers with one primary | **Built differently**: [Page/layout](../../apps/dashboard/web/src/components/layout.tsx) and view headers exist; the expanded observability surfaces use denser layouts. |
| cross-cutting | Loading skeletons rather than full-page spinner | **Built differently**: Apps has a geometric skeleton ([Apps.tsx](../../apps/dashboard/web/src/views/Apps.tsx)); other views also use loading text/cards. |
| cross-cutting | Warm icon/helper/CTA empty state | **Built differently**: the first-app [empty state](../../apps/dashboard/web/src/views/Apps.tsx) matches; operational pages use data-specific empty messages rather than one universal component. |
| cross-cutting | Card-local error with retry; danger toast on destructive failure | **Built differently**: errors are generally local to a read/action, but retry/toast patterns vary by view ([Overview.tsx](../../apps/dashboard/web/src/views/Overview.tsx), [AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx)). |
| cross-cutting | Bottom-right success/danger toast after every mutation | **Built differently**: [App.tsx](../../apps/dashboard/web/src/App.tsx) hosts toasts for central mutations; several nested settings actions render inline notes instead. |
| `[M0]` | Real provisioning status, then active/failed; no false optimistic success | **Built**: app rows and install-step refresh in [App.tsx](../../apps/dashboard/web/src/App.tsx), [Apps.tsx](../../apps/dashboard/web/src/views/Apps.tsx). |

### §4.1 Sign up / sign in

| Tag | Designed item | Result and evidence |
|---|---|---|
| `[M0]` | Centered branded auth card, validation, submitting state | **Built differently**: [SignIn.tsx](../../apps/dashboard/web/src/views/SignIn.tsx) is a retry card after failed OIDC; actual sign-up and password entry are issuer-hosted. |
| `[M0]` | Local email/password sign-in and name/email/password sign-up forms | **Not built** in dashboard by design: [SignIn.tsx](../../apps/dashboard/web/src/views/SignIn.tsx) hands off to OIDC. [dashboard.md](../architecture/dashboard.md) specifies issuer-owned login and reset. |
| `[M0]` | Optional SSO button area | **Built differently**: SSO is the real entry path; the card says “SSO options land here later” while the issuer owns choice ([SignIn.tsx](../../apps/dashboard/web/src/views/SignIn.tsx)). |
| `[M0]` | “Setting up your workspace…” interstitial and slow-bootstrap state | **Built differently**: [App.tsx](../../apps/dashboard/web/src/App.tsx) has a session interstitial and teamless [Onboarding.tsx](../../apps/dashboard/web/src/views/Onboarding.tsx); team creation is explicit, not automatic upon sign-in. |
| `[M0]` | Single-column/mobile auth | **Built** with max-width card and mobile padding in [SignIn.tsx](../../apps/dashboard/web/src/views/SignIn.tsx). |

### §4.2 Onboarding / empty overview

| Tag | Designed item | Result and evidence |
|---|---|---|
| `[M0]` | Zero-app “Create your first app” helper and CTA | **Built** in [Apps.tsx](../../apps/dashboard/web/src/views/Apps.tsx). |
| `[M0]` | Three-step checklist with links | **Built differently**: checklist and highlighted current step exist, but Invite/Domain steps are text, not deep links ([Apps.tsx](../../apps/dashboard/web/src/views/Apps.tsx)). |
| `[M0]` | Half-provisioned “finishing setup” state | **Built differently**: initial session loading and team creation have pending states; no separately named half-provisioned account panel was found ([App.tsx](../../apps/dashboard/web/src/App.tsx), [Onboarding.tsx](../../apps/dashboard/web/src/views/Onboarding.tsx)). |

### §4.3 Overview / My Apps

| Tag | Designed item | Result and evidence |
|---|---|---|
| `[M0]` | App cards: name, vertical/version, status, hostname, update, overflow | **Built differently**: [AppCard.tsx](../../apps/dashboard/web/src/components/AppCard.tsx) and [Apps.tsx](../../apps/dashboard/web/src/views/Apps.tsx) render card content; list-row `version` is blank from `AppRow`, and actions are not the exact proposed overflow list. |
| `[M0]` | Search, status filter, grid/list toggle | **Built** in [Apps.tsx](../../apps/dashboard/web/src/views/Apps.tsx); “list” is now a fleet-health table, the default. |
| `[M0]` | Provisioning pulse, poll and failed retry | **Built** in [Apps.tsx](../../apps/dashboard/web/src/views/Apps.tsx), [App.tsx](../../apps/dashboard/web/src/App.tsx). |
| `[M0]` | No-match empty and loading skeleton | **Built differently**: loading skeleton exists; filtered no-match results leave an empty grid/table rather than the proposed dedicated warm no-match state ([Apps.tsx](../../apps/dashboard/web/src/views/Apps.tsx)). |
| `[M0]` | Realtime status flips without reload | **Built differently**: polling/refresh updates status; no realtime push requirement is met by the grid ([App.tsx](../../apps/dashboard/web/src/App.tsx)). |
| `[M0]` | 3/2/1 grid and narrow icon-only primary | **Not built** as specified: [Apps.tsx](../../apps/dashboard/web/src/views/Apps.tsx) uses a fixed three-column grid and text Create App button. |

### §4.4 Create App

| Tag | Designed item | Result and evidence |
|---|---|---|
| `[M0]` | Two-step Choose/Configure wizard | **Built** on a page in [CreateApp.tsx](../../apps/dashboard/web/src/views/CreateApp.tsx). |
| `[M0]` | Catalog cards, entitlement-disabled “Upgrade” | **Built differently**: [CreateApp.tsx](../../apps/dashboard/web/src/views/CreateApp.tsx) offers live catalog/installability; the hardcoded Billing entitlement table is not its source. |
| `[M0]` | Name, URL preview, environment selector | **Built differently**: name and hostname preview exist; `ENV_OPTS` is a UI choice from `demo.ts`, while preview scopes are managed later as distinct flows ([CreateApp.tsx](../../apps/dashboard/web/src/views/CreateApp.tsx)). |
| `[M0]` | Immediate provisioning row, background completion, creation/ready toasts | **Built differently**: the real create/install path and async row state exist, with central toast handling in [App.tsx](../../apps/dashboard/web/src/App.tsx); exact two-toast copy is not a contract. |
| `[M0]` | Empty catalog, duplicate-name and failed-install recovery | **Built** as states/validation/retry in [CreateApp.tsx](../../apps/dashboard/web/src/views/CreateApp.tsx), [Apps.tsx](../../apps/dashboard/web/src/views/Apps.tsx). |

### §4.5 App Detail

| Tag | Designed item | Result and evidence |
|---|---|---|
| `[M0]` | Header, Visit, status, inline rename and overflow actions | **Built differently**: Visit/status work; rename/delete are under Settings; the header's dots button has no action ([AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx)). |
| `[M0 overview; M2 tabs]` | Overview/Data/Deployments/Previews/Settings nouns and old URL aliases | **Built differently**: [AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx) has Overview/Data/Deployments/Settings; Previews is a **Data section**, and aliases point to current sections. |
| `[M0]` | Overview summary, production URL Copy/Visit, activity timeline | **Built** with live app/deployment/audit/hostname data in [AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx). |
| `[future / registry-fed]` | Deployment versions, current badge, promote/rollback, empty state | **Built differently**: real registry/version actions and release cards ship; deployment workflow is richer than the original table ([AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx), [ReleaseCards.tsx](../../apps/dashboard/web/src/views/ReleaseCards.tsx)). |
| `[M2]` | Env key/value editor with Production/Preview/All selector | **Built differently**: a declared per-app spec and stored values drive [AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx); no selector per variable. |
| `[M2]` | Bulk “Add from .env” paste/dialog | **Not built** in [AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx). No matching parser/action was found. |
| `[M2]` | Secret reveal/copy with audited reminder | **Built differently**: secrets are write-only after save and cannot be revealed/copied; this follows the current server contract ([AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx)). |
| `[M2]` | Dirty sticky save, viewer read-only tag | **Built differently**: explicit Save configuration exists; no sticky dirty footer or generic read-only tag in the env section ([AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx)). |
| `[M2]` | App Domains list/add/verify | **Built** in [AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx). |
| `[M2]` | App Integrations subset/connect/manage | **Built** in [Integrations.tsx](../../apps/dashboard/web/src/views/Integrations.tsx). |
| `[M2]` | General rename, kind, future transfer, typed-confirm delete | **Built differently**: rename, read-only vertical metadata and typed-confirm delete ship; transfer is not a UI action ([AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx)). |

### §4.6 Team / Members

| Tag | Designed item | Result and evidence |
|---|---|---|
| `[M1]` | Roster columns, role/status and invitation actions | **Built differently**: live roster/invite/resend/copy/withdraw/remove; current [Team.tsx](../../apps/dashboard/web/src/views/Team.tsx) uses its own row layout and states. |
| `[M1]` | Multi-email chip invite and optional per-app access | **Not built**: [Team.tsx](../../apps/dashboard/web/src/views/Team.tsx) takes one email and one team role; per-app members are separate Settings controls ([AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx)). |
| `[M1]` | Read-only Roles & permissions matrix | **Mock only**: rendered matrix is `ROLE_MATRIX` from `demo.ts` ([Team.tsx](../../apps/dashboard/web/src/views/Team.tsx)). |
| `[M1]` | Show revoked toggle/history | **Not built**: [Team.tsx](../../apps/dashboard/web/src/views/Team.tsx) filters `revoked` rows out before rendering. |
| `[M1]` | Owner-only invite prompt, permission-disabled explanation | **Built differently**: team admin role controls invite UI, but the exact proposed owner-only prompt/disabled-tooltip presentation is absent ([Team.tsx](../../apps/dashboard/web/src/views/Team.tsx)). |

### §4.7 Domains

| Tag | Designed item | Result and evidence |
|---|---|---|
| `[M2]` | Account list, app link, verification status, add/verify/remove | **Built** through team domain API in [Domains.tsx](../../apps/dashboard/web/src/views/Domains.tsx). |
| `[M2]` | DNS record instructions and recheck | **Built** in [Domains.tsx](../../apps/dashboard/web/src/views/Domains.tsx). |
| `[M2]` | “Set primary” action | **Built differently**: current hostname model uses canonical bindings per surface in [AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx), not the brief's account-level primary action. |
| `[M2]` | Default-hostname empty state and exact failed-record diagnosis | **Built differently**: [Domains.tsx](../../apps/dashboard/web/src/views/Domains.tsx) and app-domain section show lifecycle-specific guidance; wording/state differ from the visual brief. |

### §4.8 Integrations

| Tag | Designed item | Result and evidence |
|---|---|---|
| `[M2]` | Provider list and connect/manage/disconnect | **Built** with server-declared fields and real connection store in [Integrations.tsx](../../apps/dashboard/web/src/views/Integrations.tsx). |
| `[M2]` | App-relevant subset and scoped connect | **Built** in [Integrations.tsx](../../apps/dashboard/web/src/views/Integrations.tsx). |
| `[M2]` | Masked secrets and nothing-connected state | **Built differently**: secrets are write-only and provider activity/health is richer than the brief; empty providers are actionable ([Integrations.tsx](../../apps/dashboard/web/src/views/Integrations.tsx)). |

### §4.9 Analytics

| Tag | Designed item | Result and evidence |
|---|---|---|
| `[future]` | Analytics route, range and app filter | **Built differently**: no route named Analytics; [Observability.tsx](../../apps/dashboard/web/src/views/Observability.tsx) is the tenant-filtered successor, using router/plane telemetry per [observability.md](../architecture/observability.md). |
| `[future]` | Four stat tiles: requests, active users, operations/day, errors, deltas/sparklines | **Built differently**: [Pulse.tsx](../../apps/dashboard/web/src/views/Pulse.tsx) shows request/error/duration and exact business-move rows; there is no active-user metric or exact four-tile layout. |
| `[future]` | Multi-app time-series and per-app breakdown | **Built differently**: one-clock Pulse and fleet health table replace the stacked chart/table composition ([Pulse.tsx](../../apps/dashboard/web/src/views/Pulse.tsx), [FleetHealth.tsx](../../apps/dashboard/web/src/views/FleetHealth.tsx)). |
| `[future]` | Empty/estimated labels and “preview” until data is wired | **Built differently**: live tenant-scoped reads exist, with unavailable/partial states; a universal preview badge is unnecessary for the live surface ([Observability.tsx](../../apps/dashboard/web/src/views/Observability.tsx)). |

### §4.10 Billing / Plan

| Tag | Designed item | Result and evidence |
|---|---|---|
| `[M3 read-only]` | Current plan card and contact path | **Mock only**: card text is hardcoded and “Contact us to change plan” has no handler ([Billing.tsx](../../apps/dashboard/web/src/views/Billing.tsx)). |
| `[M3 read-only]` | Entitlements, used/limit table tied to catalog | **Mock only**: `ENTITLEMENTS` comes from `demo.ts`; no shared live plan read ties it to Create App ([Billing.tsx](../../apps/dashboard/web/src/views/Billing.tsx)). |
| `[future]` | Payment method, period total, invoice table/download | **Mock only**: hardcoded card/amount and `INVOICES`; no payment or invoice API ([Billing.tsx](../../apps/dashboard/web/src/views/Billing.tsx)). |
| `[future]` | Clear “not yet enabled” marker and no active checkout | **Built** for the full-billing subsection: “Not yet enabled” banner, disabled card update, no checkout ([Billing.tsx](../../apps/dashboard/web/src/views/Billing.tsx)). It does not qualify the M3 sample plan figures. |

### §4.11 Account Settings

| Tag | Designed item | Result and evidence |
|---|---|---|
| `[M0 basic]` | Profile name/email/password/theme/avatar and Save | **Mock only**: static name/email and inert Save in [Settings.tsx](../../apps/dashboard/web/src/views/Settings.tsx); theme toggle lives in shell, password at issuer. |
| `[M0 basic]` | Organization name/slug/region and Save | **Mock only**: editable name is local state, derived slug and fixed region are display text, Save has no handler ([Settings.tsx](../../apps/dashboard/web/src/views/Settings.tsx)). |
| `[M0 basic]` | Typed-confirm account/org deletion | **Built differently**: real `deleteTeam` is a typed-confirm organization action, owner-gated by the server ([Settings.tsx](../../apps/dashboard/web/src/views/Settings.tsx)). |

### §4.12 and §5 Cross-cutting behavior

| Tag | Designed item | Result and evidence |
|---|---|---|
| `[polish]` | Fuzzy `⌘K` jump to app and verbs | **Built** with navigation/actions in [CommandPalette.tsx](../../apps/dashboard/web/src/components/CommandPalette.tsx). |
| `[polish]` | Event-driven notifications with unread persistence | **Mock only**: fixture feed and local boolean in [NotificationsPopover.tsx](../../apps/dashboard/web/src/components/NotificationsPopover.tsx), [App.tsx](../../apps/dashboard/web/src/App.tsx). |
| cross-cutting | In-place honesty for unbacked features | **Built differently**: many capability gaps say unavailable; full Billing is labelled; **plan figures, Settings forms, roles matrix and notifications lack a sample label** (inventory above). |
| cross-cutting | Permission-aware read-only/disabled mutations | **Built differently**: team/app role hints gate many controls, and APIs enforce writes; no universal disabled-primary tooltip pattern ([App.tsx](../../apps/dashboard/web/src/App.tsx), [Team.tsx](../../apps/dashboard/web/src/views/Team.tsx)). |
| cross-cutting | Real async and retry | **Built** for app installation and domain verification, with status/error-specific recovery in [App.tsx](../../apps/dashboard/web/src/App.tsx), [Domains.tsx](../../apps/dashboard/web/src/views/Domains.tsx). |
| cross-cutting | Secrets masked, reveal/copy per item | **Built differently**: write-only server contract means saved secrets are never revealed; connection activity may show safe redacted facts ([AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx), [Integrations.tsx](../../apps/dashboard/web/src/views/Integrations.tsx)). |
| cross-cutting | Mono identity and copy fields | **Built** in hostname, DNS, data and connection views; formatting is local per surface ([Domains.tsx](../../apps/dashboard/web/src/views/Domains.tsx), [AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx)). |
| cross-cutting | Typed confirmation for app/account/domain deletion | **Built differently**: app/team destructive flows use typed confirmation; domain removal uses a confirmation dialog naming the effect, not typed hostname ([AppDetail.tsx](../../apps/dashboard/web/src/views/AppDetail.tsx), [Settings.tsx](../../apps/dashboard/web/src/views/Settings.tsx)). |
| cross-cutting | Responsive 3/2/1 cards, drawer and stacked tables below 768px | **Built differently**: shell has responsive navigation, but [Apps.tsx](../../apps/dashboard/web/src/views/Apps.tsx) fixes its grid at three columns and several views keep horizontal tables; the full mobile contract is not met. |
| cross-cutting | WCAG AA contrast, focus, labels, dialog trapping | **Built differently**: shared UI and labelled controls cover much of this; no evidence from source inspection alone establishes WCAG AA for every current screen. A visual/keyboard audit would be required. |
| cross-cutting | Calm copy and actionable errors | **Built differently**: most live errors are specific, while static plan/profile values and blank Save actions violate the brief's honesty rule ([Billing.tsx](../../apps/dashboard/web/src/views/Billing.tsx), [Settings.tsx](../../apps/dashboard/web/src/views/Settings.tsx)). |

### Added after the brief

The built portal now includes team [Audit](../../apps/dashboard/web/src/views/Audit.tsx), a dedicated [Verticals](../../apps/dashboard/web/src/views/Verticals.tsx) build/deploy area, tenant [Observability](../../apps/dashboard/web/src/views/Observability.tsx) with Pulse, requests, patterns, lines and [Findings](../../apps/dashboard/web/src/views/Findings.tsx), [process map](../../apps/dashboard/web/src/views/ProcessMap.tsx) and [flow](../../apps/dashboard/web/src/views/Flow.tsx), request/record inspection, an Ask-capable [command palette](../../apps/dashboard/web/src/components/CommandPalette.tsx), and richer app Data/Settings sections (schema, SQL, previews, export/import, identity, members and permissions). These are additions, not omissions from the historical contract. The staff console's observability, metering and fleet operations likewise belong to a different audience.

## What to make real or build first

1. **Remove false confidence from visible mock values.** Label or hide the static Plan/entitlements, Profile/Organization Save controls, roles matrix and notification feed; wire the values where an existing source supports them. These are visible now without a sample warning, unlike the clearly labelled future payment mock.
2. **Show real unpriced usage before any invoice.** A tenant-scoped read over the existing storage, estimated request and model meters would give a paying customer a factual usage page while [#39](https://github.com/substrat-run/substrat/issues/39) keeps pricing/collection deferred.
3. **Close concrete `[M0]`–`[M3]` gaps.** The app grid/mobile table behavior, linked onboarding checklist, no-match state, member revoke history and bulk env import are implementable UI work; prioritize the first three by reach and the latter two by observed need. OIDC-owned sign-up and write-only secrets are intentional architecture differences, not gaps to reverse.
4. **Treat `[future]` as a separate decision queue.** The live Observability successor covers much of Analytics. Active-user reporting and full Billing need a product/measurement or commercial decision; do not create invoice/payment UI from fixtures.
