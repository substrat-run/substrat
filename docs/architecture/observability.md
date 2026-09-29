---
status: built
layer: plan
description: Piggyback Cloudflare; stamp only what Cloudflare cannot know.
---

# RFC: observability — piggyback Cloudflare, stamp only what Cloudflare can't know

**Status:** **built** — metrics and logs surface in the console. **Extends:** [master-plan.md](../master-plan.md) §5.3 (Tier 3
telemetry) and the "Observability per tenant" buy/build row. **Depends on:**
[orchestration.md](./orchestration.md) (WfP dispatch namespace, D-34 platform-held
credential), [dashboard-ui.md](../briefs/dashboard-ui.md) §4.9 (the cross-app screen this doc gives
a data source), [builder-plane.md](./builder/plane.md) (script → ownerTenant mapping).

## 1. Problem

Three audiences want request-level operational data, and none of them have it in-product:

- **Staff** have no fleet view — "is the router healthy, which vertical is erroring, who's
  burning CPU" — short of logging into the Cloudflare dashboard.
- **Builders** who `substrat push` a vertical have *no* path to its logs or metrics at all:
  the platform holds the Cloudflare credential (D-34), the builder never does, and there is
  no proxied read surface.
- **Tenant admins** saw the dashboard's Analytics screen, which was demo constants marked
  "Preview" (dashboard-ui §4.9 left the metrics source explicitly undefined). It is now the
  Observability page — team-level, with an app filter — reading the tenant grain below (#1447).

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

Tenant grain was deferred until one of three triggers fired: (1) a real tenant-facing
analytics page, (2) usage-based billing or quotas (the §9 meter), (3) a per-tenant support
filter. **Trigger (1) fired**, from the plainest possible direction: a team opened the
Observability tab of an app they had installed and found a sentence explaining that the
logs belonged to the vertical's builder. That is true at script grain and is not an answer
to "how is my app doing", which is a question about the installation rather than the code.

So the tenant grain is now **built**, and it is a genuinely separate path rather than a
filter over the reads above — see §4.5. It is also what the dashboard's Observability page
reads, in both its modes: one line per installed app across the team, or one app's traffic,
logs, events and schedules. A vertical's publisher gets the same tenant grain there, and
the page links up to the Vertical for the fleet answer, so the two questions each have one
home. What a tenant admin wants from an "analytics" screen is still **business activity**
(jobs created, invoices sent), which is engine events / Tier 2 (master-plan §5.3) and
remains out of scope here; this is the ops half.

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
Isolation is the read proxy's `WHERE index1 = ?`, per 4.1. The write shipped first (a few
lines, negligible cost) so that when a §3 trigger fired there would be months of history —
which is exactly how it played out: the read path (§4.5) was built against a dataset that
had been filling for months, and answered its first query about the past rather than
starting a clock.

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

**4.5 The tenant read path (view 4), as built.** Two backends, because the tenant
dimension lives in neither of the ones views 1–2 read.

*Metrics* are one SQL read of the §4.2 dataset — **named per environment, defaulted
nowhere**. Production's router writes `substrat_router` and TEST's writes
`substrat_router_test`, so a dataset name baked into the reader is a TEST control plane
charting production's traffic as a tenant's own, with a successful query and no error to
notice (the same silent inheritance as #962's dispatch namespace). It is a checked-in
`vars` entry on the control plane, `ROUTER_ANALYTICS_DATASET`; unset ⇒ the reader carries
no `tenantMetrics` and the route 501s. The read is `WHERE index1 = <tenant>`, optionally
narrowed by `blob2` (scope) and `blob1` (vertical), grouped by scope and surface. Counts
are **`sum(_sample_interval)`, never `count()`** — Analytics Engine head-samples under
load and reports each surviving row's weight, so `count()` undercounts a busy tenant by
the sampling factor, silently and in the flattering direction. Quantiles are
`quantileWeighted(q)(value, _sample_interval)` for the same reason.

The bucketed twin, `tenantMetricsSeries` (#1447), is the same SQL read with a time axis
— `toStartOfInterval(timestamp, …)` at the widths the script-grain series uses — grouped
by scope alone, so a team-level chart draws one line per app, and carrying the same two
weighted quantiles per bucket, because the chart plots latency and a whole-window
quantile cannot be unrolled into a timeline. It takes a **list** of scopes so "all my
apps" is one read — capped at `TENANT_SERIES_SCOPE_CAP` per ask, past which the dashboard
batches and merges — rides the same dataset switch (no dataset ⇒ absent ⇒ the route
501s), and refuses a page that reaches its row limit rather than returning a prefix: the
query orders ascending, so a truncated answer is missing its newest buckets, which a
zero-filling chart would draw as an outage. It is deliberately NOT the GraphQL
series `serviceMetricsSeries` reads — that dataset is keyed on the script, and no filter
on it produces a per-tenant number.

*Logs* are the telemetry query API in **two phases**, and the reason is the finding below.

> **A trace does not cross the dispatch hop.** The obvious design is to join the router's
> tenant-stamped line to the vertical's own lines by `traceId`, needing no code in a
> vertical at all. It does not work, and it fails in the direction that looks like success:
> a router line's trace reaches `substrat-control-plane` (a service binding, so the trace
> propagates) and never the dispatched vertical, while every vertical event is a trace of
> exactly **one** event. Verified from both directions against production before any code
> was written. So each vertical stamps its own line — `invocationLog()` from
> `@substrat-run/kernel`, mounted first, enforced by `pnpm lint:invocation-log`.

**The stamp is a verified assertion, not a header.** The middleware writes the line from
`readRoutedNode`'s answer, given the same `ROUTER_SECRET` and the same `ALLOW_DEV_NODE`
opt-out the vertical's own `nodeFor` uses, and writes nothing when verification fails.
Reading `x-substrat-tenant` directly would have been the #966 hole again: K-26's boundary
is that a vertical's script has no public route, which is a *deployment* fact with
`workers.dev` on by default, so an unsigned header is a claim. It matters more here than
almost anywhere, because the read path below treats a stamped line as PROOF that an
invocation belonged to a tenant and admits that invocation's other lines — which carry no
tenant of their own — on the strength of it. A forged stamp is therefore chosen text on
somebody else's dashboard, not merely a wrong row. `lint:invocation-log` refuses a mount
that passes no `routerSecret`, since that one verifies nothing and so logs nothing —
failing closed, and indistinguishable from the forgotten mount the gate already caught.

Phase one filters on `tenantId` to find the stamped lines. Phase two fetches everything
sharing their `$metadata.requestId`, which is what attributes a vertical's *own* output —
an exception, a `console.log` inside a handler — to the tenant whose request produced it,
since those lines carry no tenant of their own. The walk is capped (40 invocations × 20
lines): under-reporting a very busy window is survivable, a page that times out is not.

**An `error` read selects its own invocations**, because a level filter cannot: stamped
lines are pure JSON, so Cloudflare leaves `$metadata.level` unset on them and a level
filter drops every one — an error would then only ever arrive as a sibling of whichever 40
invocations phase two happened to expand. "An error" also arrives in three shapes, and no
one filter spans them:

| Shape | How the stamped line reads | How it is found |
|---|---|---|
| A failed response | `status >= 500` | tenant-filtered query |
| A crash that escaped `onError` | `threw: true`, `status: null` | tenant-filtered query — no comparison on `status` can match it |
| A `console.error` during a request that answered 200 | `status: 200` — nothing marks it | error-level query, searched account-wide |

The first two are the tenant's by construction. The third cannot be: an error-level line
carries no tenant, so its invocation is admitted only once phase two produces a stamped
line naming *this* tenant (and scope, and vertical, when the caller narrowed by them).
No stamped line, or somebody else's, and the whole invocation is dropped — the
conservative direction is the only allowed one here, since a line shown to the wrong
tenant is exactly what the grain decision exists to prevent. The trusted invocations also
spend the 40-invocation budget first, so a noisy neighbour's error lines cannot crowd a
tenant's own failures off their page.

Two details that are easy to get wrong and fail silently:

- Workers Logs indexes a `JSON.stringify`ed `console.log` as queryable **top-level**
  fields. The filter key is `tenantId` — *not* `$metadata.tenantId`, *not* `source.tenantId`.
  A filter on a key that does not exist returns `success: true` with zero events, which is
  indistinguishable from a tenant with no traffic. Same class of trap as the `otel` dataset
  name in `observedEgress`.
- A vertical's **successful** request emitted no log event at all before §4.2's line: the
  host logs only on a platform fault and the scope host logs nothing. A vertical's entire
  log presence was its crashes. The stamped line is therefore not only the correlation key,
  it is what gives the view any rows.

The narrowing is the same posture as everywhere else: the tenant comes from the session, a
builder principal cannot name another tenant in the query, and there is no "all tenants"
spelling in the seam — so a fleet-wide read is not one forgotten parameter away.

**Rollout is not retroactive.** The stamped line exists only in versions pushed after it
shipped, so an app keeps showing metrics (which come from the router and have months of
history) and no logs until its vertical is re-pushed. The empty state says so rather than
implying silence.

**4.6 The per-request record (#1746).** The stamped line is also where a request's
*business* facts live, so a reader can facet requests by what they did rather than by path.
It carries them as additive top-level fields, which Workers Logs indexes like `tenantId`:

| Field | Filled by | `null` / empty means |
|---|---|---|
| `level` | derived: 5xx or an escaped throw is `error`; a 4xx, or a 200 carrying a problem code (an MCP tool error answers in-band), is `warn`; else `info` | never null |
| `operation` | `mountOperations` and the MCP mount, from the name they dispatch to | a custom route, not a mounted operation |
| `problemCode` | the same mounts, `errorCodeOf` on the throw, before the vertical's own mapping | the call succeeded, or failed with nothing the kernel vocabulary names |
| `principalKind` | `ScopeStub.subjectKind`, decided by the door that minted the stub: `principal`, `connection`, `system`, `capability`, `vertical` | the stub is the vertical's own and does not say |
| `eventCount`, `eventTypes`, `entities` | `InvokeOptions.onEmitted`: the rows the operation added to the outbox, read after its commit and **before** the consumer drain | not recorded. `0` and `[]` are a fact: the call emitted nothing |
| `versionId` | the platform's `SUBSTRAT_VERSION_ID` binding | a local run, or a script pushed before the binding existed |
| `outputFields` | `mountOperations`' field walk (#1331): `{ present, empty, absent }`, the operation's declared output field names split three ways: carried with a value, carried as `null`, or not carried at all | **omitted, not `null`**: the walk is off unless the platform arms `SUBSTRAT_FIELD_COVERAGE=on`, and an unarmed line stays byte-for-byte what it was. Also omitted for a failed call, an empty list, or an operation declaring no output fields |

`outputFields` is the observed half of field coverage, whose declared half (#1321) rides the
deploy manifest. The walk costs O(declared fields), never O(response): it asks the result
about each declared name and never enumerates the result's keys. It reads the top level only,
takes the first entry of a list or paged read, and stops at 200 names, the declared half's own
cap. It runs on the operation's result before `respond`, so a vertical that owns its envelope
is observed too. It records names from the declaration only, never a value and never a
response key the declaration does not name, since a key can be data. It reads property
descriptors rather than values, so no ordinary getter and no Proxy `get` trap runs. A Proxy's
`getOwnPropertyDescriptor` trap still can, and a throw from it leaves the response
unobserved. The page (`entries`) and a list's first entry are read the same way, and a page
held behind a getter is left unobserved. `present` means an own enumerable property, not a
guarantee that it serialised: an own accessor counts as present without being called, even
though calling it could give `undefined` or throw. An inherited or non-enumerable property
counts as absent.

Names only is not the same as saying nothing. `outputFields` is derived from ONE response's
data. It sits on a line that also carries the tenant, the scope and the path, and a path can
name a record (`/customers/{id}`). So the line can disclose a fact about one identified
record: that its `phone` is null, or that it has no `terminated_at`. The line is read under
the same tenant filter as everything else on it, which keeps that fact inside the tenant
it came from. Any store built from it must still **aggregate per (operation, field)**, as
counts over a window, and never keep the per-request buckets. The question field coverage
asks is "is this field ever returned", and a count answers it without holding a fact about
any one record.

**Known gap: the MCP door is not walked.** Only the routes `mountOperations` derives record
`outputFields`. A call through the MCP mount leaves it unrecorded, so a field that only an MCP
client reads looks unread.

`entities` and `eventTypes` are distinct values from at most `EMITTED_REPORT_CAP` events,
in emission order; `eventCount` is the uncapped count. Only the operation's own emits are
named. Its consumers' follow-on events share the invocation id on the spine but are their
work, a rolled-back sub-transaction's emits are gone with it, and a failed call or an
idempotent replay committed nothing, so none of them is reported. The
`emittedReportContractSuite` holds both adapters to exactly that, across the DO hop too.

The storage decision is deliberately *this line*, not a new store. Analytics Engine would
have meant a dataset binding on every pushed script and a blob budget that cannot hold a
list of entity refs, and the Tier-2 lake answers minutes late. Workers Logs is already
tenant-filterable on this line and aggregates server-side, so facet counts and a level
histogram can be computed over a whole window instead of from the 40 × 20 sample. The price
is its 7-day retention. Module code's own log lines inheriting the same fields is a
separate step (`ctx.log`).

**The read.** Three tenant-grain routes take one shared query — tenant (forced from the
principal, as on `/tenant-logs`), window, and facet filters (`level`, `operation`,
`principalKind`, `problemCode`, `surface`, `status`; repeated values are alternatives) — so
the histogram, the counts and the list beside them always describe one set of requests:

| Route | Answers |
|---|---|
| `/observability/tenant-request-volume` | per-level counts per bar; `buckets` is a count (default 90), and the width comes back in the answer |
| `/observability/tenant-request-facets` | the top values of each facet, each counted with every *other* filter applied, plus the total |
| `/observability/tenant-requests` | the stamped lines as request records, newest first |

Lines written before the fields existed have no `level` and are counted as `unrecorded`, so the
histogram's total still matches the traffic chart. A count the backend took from a sample comes
back with `estimated: true`. All three are optional on the seam and 501 when absent, never an
empty answer that reads as "no traffic".

**How the counts are taken (#1877).** The first version aggregated raw log events at view time —
one `calculations` query per read, filtered on fields inside our own JSON. On production, at
demo volume, the grouped time series timed out after 30 s (a gateway 504), and a Lines page took
5 s: every read scanned the whole account's logs, on every view and every click, against one
account-wide quota. So the reads are now computed from **cubes**, behind the unchanged routes:

- **Every read is scoped to the app's script family** (`$metadata.service`), resolved by the
  route from the directory: the vertical's stem, which covers its serving script (#286), every
  per-version script (`<stem>-<ulid>`) and a jurisdictional one (`<stem>-eu`). A family rather
  than today's script, because a scope moves between them — a preview onto each push's script,
  a legacy scope on a rebind, any scope on `adopt-serving` — and a read of today's script alone
  would draw silence before the move. That is the scan boundary, and a trust boundary: a line
  counts only if one of the vertical's own scripts wrote it.
- An `AggregateSource` (`aggregate-source.ts`) answers **counts for one script and one span,
  grouped by tenant and every facet, cut into a grain** (10 s, 1 min, 5 min or 1 h, following the
  window). The histogram, the facets and the patterns are computed from those cubes by
  `aggregateReads` (`aggregate-reads.ts`) — once, whatever the source — and the caller's
  tenant is applied before anything else, since a cube holds every tenant of its script.
- **Logs never change**, so a closed span's counts are final. `cachedSource` splits a query into
  blocks of twelve grains; a block that closed more than five minutes ago (Workers Logs ingests
  late) is counted once and kept — in `ObservabilityCacheDO`, one object per script, via
  `sqlCubeStore` — and only the open span is read live. Grouping by tenant is what makes that
  pay: the first viewer of a block counts it for every tenant on the script.
- A span whose answer is full (2,000 groups) is **split in two** and each half counted, rather
  than paged: the telemetry API does not promise a stable order between pages. Only a single
  grain that is still full is paged, and that cube is marked incomplete so it is never kept.
- The aggregate reads refuse a call with no script list — a cube is counted per family, and an
  empty answer would read as "no traffic".
- A telemetry timeout reaches the caller as a 504 saying so, and a throttle as a 503.
- The contract suite (`aggregate-reads.test.ts`) runs the same cases over the source answering
  directly and through the cache, so a new source cannot change what the numbers mean.

**From the router's datapoints (#1904).** Cold windows did prove too slow: a first view of three
days counted seven 12-hour blocks, each a scan whose cost grows with traffic, and answered 504.
So the request cube (not the patterns) has a second source, the router's Analytics Engine
dataset, behind the same seam:

- The platform entry (`withInvocationLog`) hands the request's `operation`, `problemCode` and
  `principalKind` back on `x-substrat-invocation-record` — only on a request the router vouched
  for. The router writes them as blobs 6–8, files its own `level` (blob 9, from the status and
  that problem code) and strips the header before the response leaves. The index stays the
  tenant the router resolved, so a vertical can at most mislabel its own operations.
- The source reads one tenant (`index1`), grouped by every facet and the grain, weighted by
  `_sample_interval`. Analytics Engine samples per index, so a quiet tenant's counts are exact
  and a busy one's are estimates, flagged `estimated`. A family is `stableDeploymentRefFor` of
  the vertical slug (blob 1), so no new field names it. A query that names no tenant is
  refused, and so is an answer that saturates the row limit rather than shown as a prefix.
- Only datapoints written after the router change carry blobs 6–9, so the control plane's
  `REQUESTS_FROM_ROUTER_SINCE` names the instant it was deployed. `cutOverSource` reads a
  window's part before it from the cached telemetry cube and the rest from Analytics Engine;
  unset, everything comes from Workers Logs as before.
- Log patterns stay on the telemetry cube (a request writes many `ctx.log` lines), and so does
  the Lines list: sampling cannot find one request.

**4.7 Module log lines and patterns (#1746, #1747).** Module code logs through `ctx.log`
(`module-log.ts`): one JSON line with `substrat: 'log'`, stamped by the host with the tenant,
scope, operation, invocation id and subject kind, and carrying the template it was written
from. The tenant-log read takes these lines **directly** — they carry their own tenant, so
there is nothing to correlate — with every filter in the query, and folds them into the same
page as the stamped lines by event id. A `template` filter answers one pattern's lines. A read
narrowed by vertical alone leaves them out: they carry no vertical to match.

`/observability/tenant-log-patterns` groups the same lines by template, from the pattern cube
(template, level and operation per grain, the same source and cache as the request counts),
giving each template's count, level split and a small histogram, and its share of every
matching line. Grouping is by equality on the recorded template, not text
mining, so a pattern is exactly the lines written from one template — two call sites that
share a template share a pattern. A line written with
`console.log` has no template and is in no pattern.

## 5. What each audience gets, in build order

| # | View | Source | Cost |
|---|------|--------|------|
| 1 | Staff fleet overview (console) | GraphQL Analytics proxy | proxy route + screen |
| 2 | Builder metrics + logs/traces for owned verticals (dashboard) | GraphQL + telemetry query proxy, owner-narrowed | proxy narrowing + screen |
| 3 | Router AE datapoint (no UI) | §4.2 | a few lines, ships with 1–2 |
| 4 | Tenant analytics / debug — **built** | AE SQL read proxy + telemetry with tenant filter | proxy + the installed-app Observability tab |

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
- **Per-tenant request charts from script-grain data.** Forbidden, per §3 — it leaks, and
  §4.5 is not an exception to this: it reads a dataset the router keys on tenant, which is
  a different source, not a filter over the script-grain one. Deriving a tenant number from
  `workersInvocationsAdaptive` stays forbidden.

## 7. Open questions

1. **Workers Logs residency** — Cloudflare's observability store offers no jurisdiction
   control we could find. Same vendor we already trust for the data plane, so far softer
   than an external SaaS, but it belongs in the eu-jurisdiction accounting (K-32) before
   `jurisdiction: 'eu'` is sold as covering telemetry.
2. **Traces maturity** — early beta; billing live (shared quota with logs). Treat as a
   bonus surface in view 2, not a dependency.
3. **AE pricing at GA** — limits verified July 2026. View 4 is built and reads this
   dataset per page view, so the pricing page is now a live cost question rather than a
   pre-build one.
