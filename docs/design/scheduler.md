# The platform scheduler — the timer nothing has yet

**Status:** sketch. Depends on: [connections.md §2.1](connections.md) (the retry driver),
`HostAdmin.listConnectorState` / `sweepScriveReconciliations` (landed), `drainDue` (landed).

## 1. The gap

Two pieces of work are correct, tested, and **have no caller on a timer**:

| Work | Unit of work | Finds its work via |
|---|---|---|
| Executor retry | `host.drainDue(tenantId, scopeId)` | `listScopes({ status: 'active' })` |
| Connector reconciliation | `sweepScriveReconciliations(host, connectionId, { fetch })` | `listConnections({ provider })` |

Both are "run every so often, per unit, do the due work, record health." Neither holds a timer,
by design — a timer is a deployment concern, and inventing one per feature would scatter the same
cron across the codebase. This doc is the one home for it.

> connections.md §2.1 item 4 already named this: *"There is no queue, cron trigger or `alarm()`
> in any wrangler config today, and `alarm()` on the ScopeDO is unused. That is the natural fit
> on Cloudflare."* This is that piece, generalised past retry to cover connector sweeps too.

## 2. Poll or push? (both — poll is the substrate)

The tempting framing is "poll now, replace with webhooks later." That is the wrong shape. **A
webhook is a cache invalidation, not a fact** (connections.md §5): Scrive's callbacks are
unauthenticated and the rule is *re-fetch `documents/{id}/get`, then write*. So even with push,
the thing that runs is still `reconcileScriveDispatch` — a `get` and a record-back. Push does not
replace the reconcile; it only **triggers it sooner**.

That makes the long-term architecture concrete:

- **Poll is the durable floor, kept forever.** Webhooks get lost, providers have outages, replay
  windows expire, a capability URL gets rotated. A reconcile sweep on a timer is the source of
  truth that survives all of those. This is the Stripe model: reconcile is authoritative,
  webhooks are an optimization.
- **Push is a latency layer added on top when latency justifies it** (connections.md §5, #96).
  A webhook handler resolves `(tenant, scope, connection, instance)` from its capability URL and
  calls `reconcileScriveDispatch(host, connectionId, instanceId, { fetch })` — the *exact* call
  the sweep already makes per row. It is a faster trigger for the same driver, not a second code
  path.

So: **do not change from poll to push. Add push beside poll**, sharing one reconcile. The
decision that matters is not poll-vs-push; it is *where the poll timer lives* (§3 vs §4).

## 3. Design A — one sweep pass on a timer (landed, minus the call site)

> **Landed.** The unit of work is `runPlatformSweep(host, options)` and the node/long-lived
> trigger is `startPlatformSweeper(host, { intervalMs, … })`, both exported from
> `@substrat-run/kernel` ([platform-sweep.ts](../../packages/kernel/src/platform-sweep.ts)). Bounded
> concurrency, per-unit error isolation, and a report; tested with fakes (kernel) and end to end
> against SQLite with the real Scrive connector (connector package). What remains is a **call
> site** in a deployment, and the topology below is why that is not trivially "in the control
> plane."

`runPlatformSweep` does both halves in one pass — drain every active scope's due executor
deliveries, then reconcile every live connection — discovering its work from the directory:

```ts
const report = await runPlatformSweep(host, {
  actor: SERVICE_ACTOR,
  fetch,                                   // sanctioned egress for connector sweeps
  sweepers: { scrive: sweepScriveReconciliations },  // provider → sweeper (§3.1)
});
```

Cost is bounded by *outstanding* work, not total: the sweep skips ledger-complete rows without a
provider call, and `drainDue` is a no-op on a scope with nothing due. A quiet fleet costs two
enumerations and a lot of no-ops per pass.

### 3.0 Where it runs — NOT the control-plane worker

The obvious home looks like the control-plane worker (it builds a host, has a `SERVICE_ACTOR`).
It is the wrong one: **the control-plane's `ScopeDO` is module-less** (`defineScopeDO([], {})` —
*"nothing domain-shaped runs here; the real scope DOs live in the vertical's deployment"*). Its
host's `SCOPE` binding is that empty DO namespace, so its `drainDue` reaches no real scope and its
`getConnectorScope(…).invoke('protocol/record-signature')` reaches a DO with no protocol module.
Both halves of the sweep must run **in the vertical's own runtime**, whose host bundles the
engine modules and whose `SCOPE` namespace holds the live scopes. The directory reads
(`listScopes`/`listConnections`) still resolve against the shared control-plane DO from there, so
the vertical runtime has everything the pass needs.

So the call site is:

- **Node runtime (today).** The scrive vertical runs on `@hono/node-server` + SQLite (e.g.
  `demos/meridian`). One line in its server boot: `startPlatformSweeper(host, { actor, fetch,
  sweepers, intervalMs: 120_000 })`, and `stop()` on shutdown. `startPlatformSweeper` reschedules
  only after each pass settles, so passes never overlap.
- **Cloudflare runtime (when a vertical deploys to Workers) — landed.**
  `definePlatformSweeperDO` (`@substrat-run/adapter-cloudflare`) is the trigger: a singleton
  Durable Object whose `alarm()` runs one `runPlatformSweep` pass and re-arms itself only after
  the pass settles — the workerd analogue of `startPlatformSweeper`, with the same non-overlap
  guarantee. An **alarm rather than a cron** because a hosted vertical is pushed into a
  Workers-for-Platforms dispatch namespace, where `triggers.crons` is not honoured — a DO alarm
  is the only timer such a deployment can own, and it needs no wrangler config (it self-arms via
  `ensureArmed()`, called from provisioning or fire-and-forget per request). Where a cron IS
  available (standalone deploy, own account), point `scheduled()` at `ensureArmed()` — the §4
  safety-net shape, recovering a lost alarm rather than doing the work. Exercised end to end in
  workerd (real alarm → real pass → real directory) in
  `packages/adapter-cloudflare/test/platform-sweeper.test.ts`.

Both call the *same* `runPlatformSweep`. The blocker to a live call site is not the driver — it is
that no scrive vertical is deployed yet, and the one node vertical (`demos/meridian`) does not
register the connector or create a Scrive connection, so a sweep there would find nothing to do.

### 3.1 The seam that keeps the scheduler generic — the injected registry

`runPlatformSweep` takes `sweepers: Record<provider, ConnectorSweeper>` as an argument and imports
no connector; a connection whose provider has no sweeper is skipped and counted. The deployment
that owns the call site assembles the map (`{ scrive: sweepScriveReconciliations }`) — the one
place that legitimately depends on its connectors.

Longer term this belongs next to `registerConnector` on the host: a connector registers its
dispatch handler *and* its reconcile sweeper together, and the pass asks the host "sweep every
connection you have a sweeper for." Then a new connector is one registration, zero call-site
edits. `ConnectorSweeper` is already the shape that seam would use.

### 3.2 Where Design A runs out

- **Serial fan-out on one pass.** Iterating the whole fleet in one invocation hits CPU/wall-time
  limits and lets one slow provider delay everyone. The `concurrency` cap bounds in-flight work,
  but the ceiling is still "one runtime, one pass, whole fleet."
- **No locality.** The work for scope *X* runs in a runtime that holds none of *X*'s state; every
  `drainDue` is a fresh DO round-trip.
- **Coarse cadence.** One global interval for every tenant and provider.

Good enough for the current fleet (single-digit tenants, one connector). Not the end state.

## 4. Design B — per-scope DO alarms (the scale target)

Cloudflare's idiom is *work lives with the Durable Object that owns the state*. `ScopeDO extends
DurableObject`, and its `alarm()` is unused. The scale-target design:

- Each **ScopeDO** owns an `alarm()` that runs *its own* `drainDue` and *its own* connector
  reconciliations, then **self-reschedules** only while it has outstanding work (a due delivery,
  or a dispatch not yet complete), and lets the alarm lapse when drained. A scope with nothing
  pending costs nothing.
- **No central fan-out.** 10 000 scopes with pending work are 10 000 independent alarms, not one
  worker looping 10 000 times. It scales horizontally the way DOs are meant to.
- The **cron shrinks to a low-frequency safety net**: "wake any scope that *should* have an alarm
  set but doesn't" — recovering from a missed reschedule — rather than doing the work itself.

The migration is additive: Design A's cron keeps working as the safety net while alarms take over
the hot path, scope by scope. Nothing has to be ripped out.

### 4.1 Connections vs scopes

Retry is per-scope; a connection is `(tenant, vertical, provider)` and spans a scope. Two clean
options: the ScopeDO reconciles the connections its vertical uses (locality, but a scope must know
its connections), or connection sweeps stay on the cron (Design A) while only `drainDue` moves to
alarms. Start with the latter — retry is the higher-frequency, more latency-sensitive half.

## 5. Recommendation & next steps

1. ~~**Build the Design A driver**~~ **Done** — `runPlatformSweep` + `startPlatformSweeper` in
   `@substrat-run/kernel`, with the injected sweeper registry, bounded concurrency, error
   isolation, and tests (fakes + real SQLite end to end).
2. **Wire the call site** in the scrive vertical's runtime (§3.0). Both triggers now exist:
   `startPlatformSweeper(host, …)` in a node server (live in `demos/meridian/src/server.ts`),
   and `definePlatformSweeperDO` on Cloudflare (the alarm above). What remains is a DEPLOYED
   scrive vertical wiring one up: the node demo registers the connector behind env flags, and a
   Cloudflare deployment additionally needs the connection directory in reach — a CP-less
   dispatch vertical (scope-local-permissions.md Phase 3) has no `listConnections` to enumerate,
   so its sweep waits on connections becoming reachable from the vertical's runtime (or on the
   platform running the pass FOR dispatch verticals, the same orchestrated shape as snapshot GC).
3. **Add the sweeper registry to the host contract** so a connector registers its reconcile
   sweeper beside its dispatch handler — the call site stops assembling the map by hand.
4. **Move `drainDue` to per-scope alarms (Design B)** when fan-out latency shows up; keep the
   timer/cron as the safety net.
5. **Add webhook push (#96)** as a latency layer when a provider's poll interval is too slow — the
   handler calls the same `reconcileScriveDispatch`. Poll stays as the floor.

Step 1 is landed. Step 2 is the only thing between here and an autonomous connector, and it waits
on a deployed vertical, not on more platform code. The rest is scale and latency, each additive.
