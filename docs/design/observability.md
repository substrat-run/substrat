# RFC: observability — piggyback Cloudflare, stamp only what Cloudflare can't know

**Status:** proposed · **Extends:** [master-plan.md](../master-plan.md) §5.3 (Tier 3
telemetry) and the "Observability per tenant" buy/build row. **Depends on:**
[orchestration.md](./orchestration.md) (WfP dispatch namespace, D-34 platform-held
credential), [dashboard-ui.md](./dashboard-ui.md) §4.9 (the Analytics screen this doc gives
a data source), [builder-plane.md](./builder-plane.md) (script → ownerTenant mapping).

## 1. Problem

Three audiences want request-level operational data, and none of them have it in-product:

- **Staff** have no fleet view — "is the router healthy, which vertical is erroring, who's
  burning CPU" — short of logging into the Cloudflare dashboard.
- **Builders** who `substrat push` a vertical have *no* path to its logs or metrics at all:
  the platform holds the Cloudflare credential (D-34), the builder never does, and there is
  no proxied read surface.
- **Tenant admins** see the dashboard's Analytics screen, which is demo constants marked
  "Preview" (dashboard-ui §4.9 left the metrics source explicitly undefined).

Meanwhile the platform already pays for observability it doesn't surface: every worker has
`observability: { enabled: true }`, and Cloudflare records per-script invocation analytics
regardless.

## 2. What Cloudflare already provides *(verified against docs, July 2026)*

Nothing is scoped to a dispatch namespace — a namespace is only a container for scripts.
Every resource below is **account-level**; per-script attachment happens in the upload
metadata the WfP uploader already builds (`packages/control-plane-api/src/wfp.ts`).

**GraphQL Analytics API** — `workersInvocationsAdaptive`: requests, errors, subrequests,
CPU-time percentiles (P50/P99) per `scriptName` + `status`, with a `dispatchNamespaceName`
dimension for user workers. Query windows up to one month, for dates up to three months
back. This is what powers Cloudflare's own Workers "Metrics" tab. Zero instrumentation.

**Workers Observability / Telemetry Query API** —
`POST /accounts/:id/workers/observability/telemetry/query` (+ `keys`, `values`, and
`live-tail` endpoints): invocation events, `console.log` output, uncaught exceptions, and
(early-beta) auto-instrumented traces. Filters on any structured field
(`$workers.scriptName`, `$metadata.*`, fields of JSON-shaped log lines), aggregations up to
P999. This is what powers Cloudflare's Observability tab. Retention 7 days (paid); billed
per event past the included quota. Enabled namespace-wide via the dispatch worker or per
user worker at upload.

**Workers Analytics Engine** — custom datapoints (1 index + 20 blobs + 20 doubles),
3-month retention, SQL-over-HTTP read API, adaptive sampling *per index value*. The
documented WfP pattern for per-user aggregates: "write/query events by script tag to get
aggregates over a user's usage."

**Logpush → R2** and **Tail Workers** — the firehose options. Both scale by total traffic,
not tenant count (one job / one consumer for all producers). Deferred; see §6.

## 3. The grain decision: script first, tenant only when forced

> **Post-#286 caveat.** "A script is a vertical" is no longer one-to-one. A vertical now
> owns *two* script schemes: per-version **archive** scripts (`<slug>-<ulid>`) that admit
> and probe a push but never serve, and one **stable serving** script (`<slug>`) that
> carries all production traffic and holds the scopes' DOs (routing dispatches on
> `scope.servingRef`). Invocation metrics therefore land under the bare `<slug>`, not the
> per-version ref — so the builder owner-narrowing must map the serving ref too, or the
> per-version view reads empty. See `apps/dashboard/src/authority.ts` `ownedServiceRefs`.

A script is a **vertical**, and one vertical's worker serves every tenant that installed
it. That makes script-grain data safe for exactly two audiences and dangerous for a third:

- **Staff**: script grain is the fleet view. Free via GraphQL.
- **Builders**: script grain *is* their product's health, and the registry's
  `ownerTenant` is the access-control mapping. Free via GraphQL + telemetry query.
- **Tenant admins**: showing an installer script-level numbers for a shared vertical
  **leaks other tenants' traffic volume**. Tenant-facing means tenant-keyed data, always.
  (A private pushed vertical with one installer is script ≈ tenant, but that's a
  coincidence, not a design.)

Tenant grain is required only when one of three triggers fires, none of which is live
today: (1) a real tenant-facing analytics page, (2) usage-based billing or quotas (the §9
meter), (3) a per-tenant support filter. Until then, what a tenant admin actually wants
from an "Analytics" screen is **business activity** — jobs created, invoices sent — which
is engine events / Tier 2 (master-plan §5.3), not request telemetry, and out of scope here.

## 4. Design

**4.1 Piggyback all reads; the platform token never leaves the platform.** The control
plane (which holds the Cloudflare API token, D-34) grows thin read routes that proxy the
GraphQL Analytics API and the Telemetry Query API. The routes sit on a **provider-neutral
seam** (`ObservabilityReader` in `control-plane-api/src/observability.ts` — neutral
vocabulary: *service*, *namespace*, never *script*), with the Cloudflare reader as one
injected implementation (`cf-observability.ts`) — the `DeployVerticalFn`/`wfp.ts` pattern,
honouring master-plan §5.7: Cloudflare is the deployment target, not a dependency. An
APM/OTel backend slots in behind the identical routes later without touching any consumer. The console renders the staff fleet
view over them unfiltered; the dashboard renders the builder view with the query narrowed
**server-side** to scripts whose registry `ownerTenant` is the caller's tenant. The
narrowing lives in the proxy, same posture as `TenantNarrowedControlPlane` — never in the
client, never in the token.

The log read narrows to a **set** of services, not one: a builder's unit of interest is a
vertical, which serves from several deployed units at once (the stable serving script plus
per-version archives), so the dashboard's "all versions" asks for them together and the
seam answers one stream merged newest-first, capped at `limit` overall. Unowned refs are
dropped by the narrowing before the plane is asked, so a mixed set is a request, never a
claim — asking for someone else's service alongside your own simply omits it.

**4.2 Stamp the tenant dimension at the router — write now, read later.** The one fact
Cloudflare structurally cannot record is which *tenant* a request belonged to. The router
computes it on every request at hostname-resolve time, so the router writes one Analytics
Engine datapoint per dispatched request:

- **index**: `tenantId` (AE samples fairly per index value; dashboard queries are always
  tenant-scoped, so this is the pruning key)
- **blobs**: vertical slug, scope, surface, status class, ray id
- **doubles**: duration ms, status code

One shared dataset — *not* per-namespace or per-tenant datasets, which buy no isolation
(reads go through the account-level SQL API regardless) and multiply query fan-out.
Isolation is the read proxy's `WHERE index1 = ?`, per 4.1. The write ships **now** (a few
lines, negligible cost) so that when a §3 trigger fires there are months of history; the
read path waits for the trigger.

**4.3 Structured-log convention.** The router logs one JSON line per request carrying
`tenantId`, vertical, scope, and ray id. The telemetry query API filters on structured
fields, so this is what makes a future tenant-scoped *log* view possible (proxy injects
`tenantId = <session tenant>`; lines without the field are never shown to tenants). This
refines — does not replace — the master-plan convention "tenant/scope IDs on every trace
and error": the convention stands, the default backend is Cloudflare-native rather than an
external APM.

**4.4 Enable observability on pushed scripts.** The WfP uploader sets
`observability: { enabled: true }` in upload metadata so builder logs exist to query.
Namespace-wide enablement via the router covers the rest.

## 5. What each audience gets, in build order

| # | View | Source | Cost |
|---|------|--------|------|
| 1 | Staff fleet overview (console) | GraphQL Analytics proxy | proxy route + screen |
| 2 | Builder metrics + logs/traces for owned verticals (dashboard) | GraphQL + telemetry query proxy, owner-narrowed | proxy narrowing + screen |
| 3 | Router AE datapoint (no UI) | §4.2 | a few lines, ships with 1–2 |
| 4 | Tenant analytics / debug *(deferred until a §3 trigger)* | AE read proxy + telemetry with tenant filter | proxy + wire existing Analytics UI |

Live tail is a cheap follow-on to 2 (the API has first-class endpoints for it).

## 6. Explicitly not chosen

- **External APM SaaS as the system of record** (Datadog/Sentry/Better Stack). Two
  grounds: (a) no observability SaaS does end-user multi-tenancy, so the tenant-scoping
  proxy — the actual work — gets built either way; (b) shipping every tenant's logs to a
  third party undercuts the jurisdiction story (K-7/K-32) before Regional Services lands.
  The master-plan's "APM vendor swappable" stance survives as the §4.3 convention: because
  tenant/scope ride on every log line and AE datapoint, an APM backend can be added behind
  the same proxy later without touching producers.
- **Logpush → R2 firehose.** The archival/compliance path (R2 supports EU-jurisdiction
  buckets), wanted only when someone needs raw log retention beyond 7 days. Not a query
  backend.
- **Tail Workers.** Only if a per-tenant "recent exceptions" store is demanded beyond what
  telemetry-query filtering provides. Revisit, don't pre-build.
- **Per-tenant request charts from script-grain data.** Forbidden, per §3 — it leaks.

## 7. Open questions

1. **Workers Logs residency** — Cloudflare's observability store offers no jurisdiction
   control we could find. Same vendor we already trust for the data plane, so far softer
   than an external SaaS, but it belongs in the eu-jurisdiction accounting (K-32) before
   `jurisdiction: 'eu'` is sold as covering telemetry.
2. **Traces maturity** — early beta; billing live (shared quota with logs). Treat as a
   bonus surface in view 2, not a dependency.
3. **AE pricing at GA** — limits verified July 2026; re-check the pricing page before the
   tenant read path (view 4) is built.
