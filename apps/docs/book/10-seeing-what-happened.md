---
description: "Sampled router traffic, tenant-stamped invocation logs, opt-in traces, and the event spine read through history, cause, effects and same-call — and which question each answers."
---

# 10. Seeing what happened

The last chapter ended on reports that background work returns so that something can read
them. This chapter is about the reading. It covers what the platform records about a running
vertical, where each record lives, and which question each one can answer.

There are four instruments, at four different grains, and the most common mistake is to ask
one of them a question only another can answer:

| Instrument | Grain | Exact or sampled | Answers |
|---|---|---|---|
| **Traffic** | one datapoint per request, at the router | sampled | how much, how fast, how many errors |
| **Invocation logs** | one line per request, written by the vertical | exact while retained | what this request did, and what it printed |
| **Traces** | spans the runtime produces | sampled, opt-in | where outbound time went |
| **The spine** | one row per mutation, per delivery, per denial | exact, forever | what happened to the data, who did it, and what it set off |

The first three are about *requests*. The fourth is about *meaning*, and it is the one that
cannot be rebuilt from anything else.

## Traffic: the router counts

Every request passes the router (chapter 3), so that is where it is counted. Once dispatch
returns, in a `finally` so errors count too, the router writes one Analytics Engine datapoint:

```
index:   [tenantId]
blobs:   [verticalSlug, scopeId, surface, statusClass, rayId]
doubles: [durationMs, status]
```

The index is the tenant, so every read of this dataset is a read of one tenant. The dashboard's
chart is a sampling-weighted `sum(_sample_interval)` with weighted quantiles for latency, run
through the Analytics Engine SQL API.

**The data is sampled.** It is the right instrument for "is this app getting slower", and the
wrong one for anything that has to be exact, such as an invoice (chapter 12) or proof that a
particular request happened. A sampled count is an estimate, and it presents itself as one.

## Logs: the vertical writes its own line

This is the instrument with the least obvious design, and the reason for it is a platform fact.

Workers observability is keyed on the **worker script**. A vertical's script serves *every*
tenant that installed it. And a trace does not cross the router's dispatch hop into the
vertical. So the router knows the tenant and cannot label the vertical's log lines with it,
and the vertical's log lines, unlabelled, belong to nobody in particular. A tenant's
Observability page would be either empty or someone else's.

So the vertical writes the line itself. One middleware, mounted first:

```ts
app.use('*', invocationLog({ routerSecret: (env) => env.ROUTER_SECRET }));
```

It writes one JSON line per request to Workers Logs, in a `finally`, so logging can never fail
the request:

```
substrat: 'invocation'
tenantId, scopeId, vertical, surface
method, path          // the path only; the query string is dropped, so no OIDC code is logged
invocationId          // a ULID minted for this request
status, threw, durationMs
```

Workers Logs indexes JSON fields, so `tenantId` becomes a filter. Reading a tenant's logs takes
two phases. The first finds that tenant's invocation lines. The second uses Cloudflare's own
per-request `$metadata.requestId` to fetch every other line the same request printed, including
a stack trace from code that has never heard of tenants.

Three details come from getting this wrong once:

- **The tenant comes from `readRoutedNode`, never from a header read directly.** A forged stamp
  would put text the forger chose onto another tenant's dashboard. So `routerSecret` is
  required: without it every assertion fails verification and **nothing is written**. From the
  outside that looks the same as no traffic, which is why a bare `invocationLog()` is refused.
- **It must be the first registration.** Hono composes handlers in registration order, so a
  mount below some routes logs part of the surface and stays silent for the rest, which reads
  as "no traffic on those routes". `lint:invocation-log` checks the *order*, not just that the
  mount exists. The scaffold template ships with the mount in place.
- **It is not retroactive.** Only versions pushed after a vertical adopted it write lines.

## Traces: opt-in, and narrower than the word suggests

Automatic tracing is set per push, from a sampling rate the control plane holds. Today that rate
is on in the test environment and off in production. Nothing in the platform emits a span per
operation, permission check or engine call. What reaches the trace data is what the runtime
generates on its own, mainly outbound `fetch` and the Durable Object entry hop. The platform
reads it for one purpose: comparing a version's *observed* egress with its *declared*
allowlist (chapter 8).

A per-operation waterfall is designed and not built. That is part of why the next section
matters.

## The spine, read as an instrument

Chapter 5 described the outbox as the audit log. It is also the best observability data the
platform has. Every row is exact, typed, stamped by the kernel, and kept. The kernel ships
**sanctioned reads** over it, and the dashboard puts each one behind a button, so nobody has to
write SQL against the spine to use it.

**History.** `readHistory` returns one entity's events, newest first, with the fields a hand-rolled
`SELECT` would misread: the authorization chain, the impersonation stamp, the operation, the
deployed version. In the dashboard, opening a record under an app's **Data** tab shows this
timeline.

**Why?** Every event emitted while a delivery is in flight records `causedBy`, the id of the
event whose consumer emitted it. `walkEventCause` follows that link backwards. It says how the
walk ended (complete, cut, depth limit, or a missing link), so a short chain is never mistaken
for a complete one.

**What did it do?** `walkEventEffects` goes forward. It builds a tree from the delivery journal:
which consumers an event reached, whether each one handled it, is retrying, or gave up, and how
many attempts it took. This is where `_substrat_deliveries` shows up in the dashboard. It is not
a raw table of deliveries but the delivery rows hanging off the event that caused them.

**Same call.** This joins a data change to a request. The vertical host mints the
`invocationId` that the log line carries, passes it into `invoke`, and the kernel stamps it
on every event the call emits, including events that consumers emit in that call's
post-commit tail. `readInvocation` returns everything one call did. The same id is on the log
line, so a record's call can be matched to the request that made it. That match is by hand
today: the Logs view does not yet filter by invocation id.

That join has limits, and they are exact:

- It exists only for operations reached over the vertical host's HTTP operation route. Seeds,
  internal calls and events from before the column existed carry `null`.
- The router's datapoint carries Cloudflare's `rayId`, not the `invocationId`, so traffic does
  not join to events.
- **Denials and deliveries carry no invocation id.** A delivery joins through its event, and a
  denial joins to nothing but its time and actor.

**Facets.** `facetEvents` is a small group-and-count over one scope's outbox. It filters by type
and time window, groups by type, actor, operation, version, entity type, PII class, invocation,
or one payload field, and returns counts per bucket. Each bucket carries `lastSeen`, the time of
its latest event. That tells a path that **stopped** (it has old events) from a path that
**never ran** (it has none). Erased payloads are counted separately rather than folded into a
"null" bucket. This is the **Events** explorer.

**Flow.** `substrat push` records what each module *declares* it emits and consumes. The dashboard
compares that with what the outbox *shows* happening. Triggers lead to modules, modules to event
types, event types to the outside world, and anything declared but never observed is drawn
dashed. Next to it, per-operation health joins emitted events with the denial log, grouped by
operation. That is where a role missing a permission key shows up before a user reports it.

## Absence is a signal too

Everything above records things that happened. The hardest failure to see is a job that never
ran, because that failure leaves no row anywhere.

Two mechanisms produce the row:

- **Freshness expectations.** A manifest can declare
  `freshness: [{ eventType, within: { hours } }]`. The platform sweep (chapter 9) checks each one
  and records a verdict. "No `invoice.sent` in 26 hours" becomes a fact instead of a hunch.
- **Sweep runs.** Every unit of sweep work is recorded, whether it was a schedule, a freshness
  check or a connector poll. The Schedules panel turns those records into four verdicts: *On
  schedule*, *Overdue*, *Never run*, and *No sweep data*. The last two are deliberately different.
  Module code cannot forge these rows: `ctx.requestPlatform` refuses the kind the platform uses
  to write them.

## Where each one surfaces

For a customer's admin, in the **Dashboard**:

- **Observability** (a team page, filtered by app): *Traffic* (the router's data), *Health*
  (worst first), *Logs* (invocation lines), *Events* (facets), *Schedules* (sweep runs), and
  *Flow* (declared versus observed, plus per-operation health).
- An app's **Data** tab: a record's history, with *Why?*, *What did it do?* and *Same call* on
  each event.
- An app's **Settings → Integrations**: the platform-request journal, meaning what the platform
  did with each intent the app raised.
- An app's **Overview**: a status band, a traffic sparkline, and release markers on the chart.

For Substrat operators, in the **Console**: the fleet views, plus *Operations → Failures, Issues
and Sweeps*. Failures are grouped into issues by fingerprint, so a thousand identical errors
appear as one row with a count.

One property holds across all of them. **Every read that reaches into a scope on a tenant's
behalf leaves an access-log row** that names what was read. Looking at data is itself recorded,
which is where the next chapter starts.

## What this does not give you

- **A raw outbox or delivery-journal browser.** Events are reached through facets and through
  records, and deliveries through the event that caused them. The spine's tables appear under
  *System* in the table browser, but there is no dead-letter list across a scope. Finding every
  consumer that gave up this week is a query nobody has built into a view.
- **Exact request counts.** Traffic is sampled.
- **Cross-scope event questions.** Every read above is one scope. "Across all forty branches" is
  forty reads, or it is the lake.

---

**Next:** [The audit trail and the lake →](/book/11-audit-and-the-lake)
