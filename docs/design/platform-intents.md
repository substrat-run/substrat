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

## Open questions

- **Router→drain wiring.** How the router reaches the prompt-drain path (a binding to the sweeper
  DO / control plane). The router is privileged and in-path, so this is a small addition — but it
  is the one new platform coupling and should be spec'd concretely before build.
- **Result delivery.** For site creation, completion is observable via the M2 registry (poll
  `/api/sites`). A general reader for `result`/`status` by request id is the generic form — worth
  defining once so every intent kind reports the same way.
- **Intent-kind registry + validation.** Where the platform registers `kind → handler` and the
  payload schema per kind; how an unknown `kind` fails (drop to `failed` with a clear error).
- **Backpressure / rate limits.** Per-scope caps so a stuck or abusive vertical can't flood the
  drain; interaction with the per-plan quota gate.
- **Ordering.** Per-scope FIFO vs. unordered. Site creation doesn't need ordering; some future
  intent might.

## Why this is the right long-term shape

It resolves the tension that broke every other design: **sandbox purity vs. interactive latency.**
Durable pull keeps the vertical purely inbound (the invariant intact); the router kick gives
seconds-scale latency; the sweep guarantees delivery. It is **general** — one primitive for every
privileged action a vertical needs — and it reuses the machinery the platform already runs
(spine queue + coordinator-side execution + the kickable sweeper). Site creation is intent #1.
