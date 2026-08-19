---
status: built
layer: kernel
description: How a sandbox-clean vertical requests a privileged platform action.
---

# Platform intents — how a sandbox-clean vertical requests a privileged platform action

**Status:** proposal (K-decision-scale) · **First consumer:** Manyfold self-serve site
creation (`multi-scope-manyfold.md` M3) · **Related:** #303 (outbound policy), K-27 (verticals
reach the platform only through the router), K-31 (the platform owns provisioning).

## The problem (general, not Manyfold-specific)

A hosted, **sandbox-clean** vertical sometimes needs to cause a **privileged, platform-owned
mutation** — provision a sibling scope, request more quota, bind a custom domain, provision a
tenant-store — **on behalf of a user it has authorized with its own roles**. Today it cannot,
and every obvious way to let it erodes something load-bearing:

- **It has no upward channel.** `assertSandboxContract` ([`deploy.ts`](../../packages/control-plane-api/src/deploy.ts))
  refuses `CONTROL_PLANE`/`service`/`dispatch_namespace` bindings — a vertical reaches the
  platform "only through the router (K-27), never a service binding." Its only secrets are the
  **global** `PLATFORM_SECRET` and `ROUTER_SECRET` (the same value in every vertical), so a
  secret it holds can never *identify* it, and accepting that secret inbound would authorize
  "any vertical" as "the platform."
- **A synchronous outbound call erodes the sandbox.** Giving the vertical a URL + `fetch` to the
  control plane means an injected endpoint, an egress hole (the outbound policy #303 is still
  undecided), and a credential to mint/rotate — spending the isolation invariant for one feature.

Site creation is merely the **first** instance of this shape. The right answer is a *general
primitive*, and it should not cost the sandbox contract.

## The idea: verticals don't push to the platform — the platform pulls from them

Substrat already has this pattern. A vertical records intent in its **own** DO; a platform
component drains it and acts with `HostAdmin` authority. That is exactly how **executors** work
today — the scope DO's `pendingExecutorEvents` is a *read* in the DO, and "executors run on the
COORDINATOR, not here: they act through `HostAdmin`, which is outside this DO"
([`scope-do.ts`](../../packages/adapter-cloudflare/src/scope-do.ts) ~L802). The outbox
(`_substrat_outbox`) → delivery (`_substrat_deliveries`) → coordinator-side effect is the same
shape.

**Platform intents apply that shape to platform lifecycle actions.** A vertical enqueues a typed
intent in its scope DO; the platform drains it and executes with `HostAdmin`. The decisive
property: **identity is inherent, never asserted.** The platform is reading *a specific scope's
DO*, so it already knows `(tenant, scope)` — there is no secret to identify the caller, no
tenant to derive from a claim, nothing to forge. The intent's authority comes from *where it
physically lives*.

```
vertical operation (after its OWN permission check):
    ctx.requestPlatform({ kind: 'provision-sibling', payload: { slug, name, owner } })
        │  kernel writes _substrat_platform_requests  (this scope's DO, spine — module code can't)
        ▼
platform drains it (knows THIS scope's tenant inherently) ──▶ host.provisionScope + provisionInstance
        │                                                        └─▶ /internal/provision ─▶ M2 site registry
        ▼
result recorded on the request row; the app polls and the new site appears
```

Nothing here is an outbound call. The vertical writes to its own DO (allowed) — the sandbox
contract is **untouched**.

## Latency: durable pull, router-kicked, sweep-backstopped

Naive pull is too slow — the platform sweep runs every **~2 minutes**
([`platform-sweeper-do.ts`](../../packages/adapter-cloudflare/src/platform-sweeper-do.ts),
`intervalMs: 120_000`). But the sweeper is explicitly *kickable*: it exposes `sweepNow`, and its
alarm is armed **fire-and-forget from ordinary request paths** (`ctx.waitUntil(stub.ensureArmed())`)
— the 2-minute alarm is the *safety net*, not the only trigger. So real latency is "how fast we
kick it," and a platform component sits right in the request path to do so: **the router.**

Three layers, each doing one job:

1. **Durable queue (reliability).** The intent is a committed row in the scope DO. It cannot be
   lost; it will execute even if every fast path fails.
2. **Router kick (interactivity).** The vertical returns its response with a header flagging
   "I enqueued a platform request" (e.g. `x-substrat-platform-request: 1`). The router, already
   relaying that response and already knowing `(tenant, scope)` from routing
   ([`router worker`](../../apps/router/src/worker.ts)), fires `ctx.waitUntil(promptDrain(tenant, scope))`.
   This is **router→platform, not vertical→platform** — the vertical made no outbound call. The
   intent executes in **seconds**.
3. **Periodic sweep (backstop).** The existing ~2-min sweep gains a platform-request drain phase,
   so a missed kick still lands.

## The pieces

### 1. The intent record — `_substrat_platform_requests` (spine, per scope DO)

```sql
CREATE TABLE _substrat_platform_requests (
  id            TEXT PRIMARY KEY,              -- ulid; the idempotency key
  kind          TEXT NOT NULL,                 -- 'provision-sibling' | 'request-quota' | …
  payload       TEXT NOT NULL,                 -- JSON; validated by the platform handler for `kind`
  requested_by  TEXT NOT NULL,                 -- the principal from ctx (audit; NOT re-checked below)
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | done | failed
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  result        TEXT,                          -- JSON, e.g. { scopeId } once done
  requested_at  TEXT NOT NULL,
  settled_at    TEXT
);
```

It is **spine** — written only by the kernel (module code may never write `_substrat_*`), read
and settled only by the platform drain.

### 2. The kernel verb — `ctx.requestPlatform`

A new `OperationContext` method, sibling to `ctx.emit`/`ctx.check`/`ctx.link`:

```ts
ctx.requestPlatform({ kind: string, payload: unknown }): string  // returns the request id
```

Called by a vertical operation **after its own permission check**, in the same transaction as
the operation. The kernel records the row (stamping `requested_by` from `ctx`) and returns the
id so the vertical can report "pending" and the app can poll it. **The kernel does not interpret
`kind`** — it is an opaque, durable, typed queue, exactly as the outbox is agnostic to event
types. Intent vocabulary is the *platform's*, keeping the kernel domain-free (three-layer rule).

### 2b. The kernel read — `ctx.platformRequests` (#618)

The write had been a first-class verb since day one and the read was nothing, which meant a
vertical could ask the platform to do something and then had no supported way to learn whether
it happened. An app showed a contract as "out for signature" while its `connector:scrive` intent
had been `failed` for a fortnight.

```ts
ctx.platformRequests({ kind?: string, status?: PlatformRequestStatus, limit?: number }): PlatformRequest[]
```

Synchronous, scope-local (it is this scope's own spine table), newest first. Rule 3 already
permits a projection read of `_substrat_*`, but a hand-rolled `SELECT` pins a vertical to a
private schema — this is the stable shape, returning the same `PlatformRequest` the platform
settles. Read-only by construction: the kernel owns every write to that table, so an intent's
status is only ever the platform's answer.

### 3. The drain-executor (platform / control plane)

A registry of `kind → handler`, run in two places that share one code path:
- **the prompt scoped drain** (router-kicked, one scope), and
- **a new phase in `runPlatformSweep`** ([`platform-sweep.ts`](../../packages/kernel/src/platform-sweep.ts)) — the backstop, all scopes.

For each `pending` request the handler runs with `HostAdmin` authority. `provision-sibling`:
parse the payload (Zod), and — reading *this* scope's DO, so the tenant and the parent scope are
known — mint the sibling scope id **once** and write it to `result` before provisioning
(two-phase, like previews/snapshots), then `provisionScope` + `provisionInstance` for the sibling
under the same tenant + vertical, and mark the row `done`. Failure increments `attempts`, records
`last_error`, and leaves it `pending` for retry. Idempotency key = the request id; the
pre-recorded sibling id makes a retried provision a no-op (K-31).

### 4. The router kick

The router recognises a generic response header ("this scope has a pending platform request") and
fires a fire-and-forget scoped drain for that `(tenant, scope)`. It is **generic**: the router
never learns "site creation" — it only knows "drain scope S," and the control-plane handler
interprets the `kind`. Wiring the router → drain path (a binding to the sweeper/control plane) is
an implementation detail below.

## Authorization & isolation

- **Authorization is the vertical's.** It calls `ctx.requestPlatform` only after checking its own
  role (Manyfold: the tenant-wide `admin`, or a `manyfold:manage-sites` permission). The platform
  does **not** re-check a domain permission it does not own; it records `requested_by` for audit
  and applies **platform** policy (quota, entitlement) at drain time — the natural gate.
- **Isolation is the platform's, and inherent.** An intent physically lives in one tenant's scope
  DO. The platform executes it against *that* tenant — it never reads a tenant from a claim. A
  vertical can only write intents to scope DOs it owns, so it can only ever cause actions for its
  own tenants. A buggy/hostile vertical's blast radius: extra scopes for tenants that already run
  it, bounded by quota. **No global secret, no outbound channel, no cross-tenant reach.**

## First consumer — Manyfold site creation (M3)

- A Manyfold permission (`manyfold:manage-sites`, held by the owner/admin) + an operation
  `manyfold/request-site` that checks it and calls
  `ctx.requestPlatform({ kind: 'provision-sibling', payload: { slug, name, owner } })`.
- Worker `POST /api/sites` invokes it, returns `202` + the request id, and sets the response
  header that triggers the router kick.
- The `provision-sibling` handler provisions the sibling → `/internal/provision` → the M2 site
  registry records it.
- Manyfold UI: **New site** → `POST /api/sites` → "creating…" → poll `/api/sites` (M2) → the new
  site appears → switch to it.

## Non-goals

- **Not general synchronous RPC.** Intents are fire-and-forget with polled results, for occasional
  privileged *lifecycle* actions — not a hot-path request/response channel.
- **No tenant naming by the vertical.** Identity is inherent to the DO; a vertical can never target
  another tenant.
- **No relaxation of the sandbox contract.** The vertical stays purely inbound. This is the whole
  point.

## Resolved decisions (implementation-ready)

- **Router→drain wiring.** The router gets a **service binding to the control-plane worker** (it is
  privileged platform infrastructure, not a sandbox-clean vertical, so a service binding is
  legitimate — the same pattern the dashboard already uses). On seeing the
  `x-substrat-platform-request` response header from a dispatched vertical, it fires
  `ctx.waitUntil(cp.drainScope(tenant, scope))` against a new **platform-secret-gated
  `POST /internal/drain-scope`** on the control plane, which runs the drain-executor scoped to that
  one scope. Best-effort: a failed kick is caught by the ~2-min sweep.
- **Result delivery.** v1 relied on the **domain-observable effect** — `provision-sibling` completes
  when the site shows up in the M2 registry, so the app polls `GET /api/sites`. The generic form
  landed with **#618**, when the first intent kind with no observable domain effect arrived:
  a `connector:<provider>` delivery that fails leaves the vertical's own state (a contract in
  `pending_signature`) looking exactly like success. Three reads, one journal:
  `ctx.platformRequests` in the vertical (2b above), `ScopeHost.listPlatformRequestHistory` for the
  platform, and `GET /tenants/:t/scopes/:s/intents` on the control plane — which is what the
  dashboard's integration detail renders, `lastError` **verbatim and untruncated**.
- **Retry classification (#618).** `pending` means *try again*, and a handler that throws gets it by
  default — correct for a provider outage, wrong for a provider's refusal. A **4xx carrying a
  status** (`isTerminalProviderError`, `packages/kernel/src/provider-error.ts`) settles `failed` on
  the first attempt: it is the provider telling the caller its request is wrong, and attempt 101
  sends the identical bytes. 5xx, timeouts (408), locks (423/425) and rate limits (429) stay
  retryable, as does anything with no status — an unclassifiable failure must never be settled
  terminally. Every terminal settle now also lands an **ops-failure row** (`stage: 'terminal'`),
  the same visibility the attempt ceiling already got.
- **Intent-kind registry + validation.** The platform holds a `Record<kind, { schema, handle }>`
  (registered where `runPlatformSweep`'s connector sweepers are). The drain parses `payload` with the
  kind's Zod schema and runs `handle` with `HostAdmin`; an **unknown kind or a parse failure marks
  the request `failed` with a clear `last_error`** — never a silent drop. The kernel stays agnostic
  (opaque `kind`/`payload`), mirroring the outbox.
- **Backpressure.** Two bounds for v1: `ctx.requestPlatform` **refuses when the scope already has N
  pending requests** (the operation fails, surfacing to the user), and the drain processes a
  **bounded batch per scope per pass**. For `provision-sibling` specifically, the per-plan site
  quota (the M1 gate) is the real limiter. Sophisticated per-tenant rate limiting is deferred.
- **Ordering.** **Unordered** per scope (each request is independent + idempotent). Site creation
  needs no ordering; if a future intent kind does, it carries its own sequencing in `payload`.

## Why this is the right long-term shape

It resolves the tension that broke every other design: **sandbox purity vs. interactive latency.**
Durable pull keeps the vertical purely inbound (the invariant intact); the router kick gives
seconds-scale latency; the sweep guarantees delivery. It is **general** — one primitive for every
privileged action a vertical needs — and it reuses the machinery the platform already runs
(spine queue + coordinator-side execution + the kickable sweeper). Site creation is intent #1.
