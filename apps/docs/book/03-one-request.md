# 3. The path of one request

Someone opens a browser, types a hostname, and clicks a button that creates a work order.
This chapter is every hop between that click and the committed row, in order.

It is the chapter the reference does not have. [Router](/platform/router) stops at the
service binding. [`@substrat-run/vertical-host`](/reference/vertical-host) starts at
`/internal/*`. [Operations & the scope host](/concepts/scope-host) starts at `invoke()`.
Each describes its own hop well and none of them describes the joins, so here they are.

```
browser
  │  https://acme-north.example.com/api/invoke
  ▼
[1] router worker            hostname → (tenant, scope, vertical, surface)
  │  x-substrat-tenant / -scope / -surface / -vertical / -router
  ▼
[2] dispatch                 env.DISPATCH.get(deploymentRef)
  │
  ▼
[3] the vertical's door      readRoutedNode → authenticate → principal → join
  │
  ▼
[4] CloudflareScopeHost      lifecycle gates → lazy migrate → mint stub
  │  stub.invoke('workorder/create', input)
  ▼
[5] ScopeDO                  queue → transaction → parse → guards → handler
  │
  ▼
[6] post-commit              outbox → consumers
  │
  ▼
response                      x-substrat-request-id: <the request's id>
```

## [1] The router finds the door

One worker sits in front of every vertical. Its entire job is: turn a hostname into a
`(tenant, scope, vertical, surface)` target, and forward.

It resolves that against the control-plane directory, uncached, once per request. Not
caching a route is a deliberate choice rather than an omission: a cached route that keeps
serving a suspended tenant blunts suspension, and suspension is a live weapon — it is
what you reach for when a customer must stop being served *now*. The cost is a directory
read per request; the alternative is a suspension that takes effect eventually.

Only `active` hostname bindings resolve. A domain still validating its DNS, or one whose
certificate failed, is simply unknown and gets "No application is configured for this
hostname."

Notice what the router deliberately cannot do. It binds what forwarding needs — the
control-plane directory it reads, the dispatch namespace it forwards into — and **no
`SCOPE` namespace**. It resolves names; it has no way to open a scope's database.
That boundary is a deployment fact written into its wrangler config rather than a rule
somebody follows. Handing the router the full scope host would have saved a file and
given the name-resolution worker authority over every tenant's data.

It also does not re-check tenant suspension, even though it reads the directory and
could. `getScope` owns that, inside the vertical. A second enforcement point is a second
thing that can disagree with the first; the router's job is to find the door, not to
decide who may open it.

### The trust boundary

The router forwards with the resolution in headers:

```
x-substrat-tenant:   01J8F...
x-substrat-scope:    01J8G...
x-substrat-surface:  app
x-substrat-vertical: fsm
x-substrat-router:   <shared secret>
```

The vertical trusts these **absolutely** — they name whose data it is about to serve. Two
things make that safe, and both are required:

1. **Vertical workers have no public route.** `workers_dev: false`, no route; reachable
   only by service binding or dispatch from the router.
2. **`ROUTER_SECRET`** — the same value on the router and every vertical, presented as
   `x-substrat-router` and verified by `readRoutedNode` in `@substrat-run/vertical-host`.

The second exists because the first is a deployment fact and `workers.dev` is on by
default. One forgotten toggle makes (1) false with nothing in the code noticing, and the
consequence is a cross-tenant read.

Both halves **fail closed**. A router with no `ROUTER_SECRET` answers 500 to everything.
A vertical deployed without one refuses any asserted node with a `RouterAssertionError`
rather than trusting unsigned headers — this used to be a trust-by-default, which meant a
worker missing its secret would accept a forged tenant from anyone who could reach the
script directly. The only opt-out is `ALLOW_DEV_NODE`, which names an un-routed local
instance and authenticates nobody.

And the router **strips every inbound `x-substrat-*` header by prefix** before setting its
own, so a client cannot forge a node by simply sending one. Stripping by prefix rather
than by name is why adding a sixth asserted header later cannot reopen the hole.

## [2] Dispatch

With a target in hand, the router picks the worker.

If the resolved route carries a `deploymentRef` — the Workers-for-Platforms handle for the
scope's bound version — it dispatches into the namespace: `env.DISPATCH.get(deploymentRef)`.
This is how customer-pushed verticals are reached, and it is the normal path. If there is
no bound version, it falls back to a static `VERTICAL_<SLUG>` service binding, the
original shape, kept for routes that predate the registry.

Every dispatch also carries the **outbound policy** for that version — the declared egress
allowlist from its manifest — handed to the egress worker through the dispatch binding's
outbound parameters. The router never inspects that list; resolution produced it and the
egress worker enforces it. Chapter 5 picks this up where connectors do.

Two facts fall out of dispatching on `deploymentRef` rather than on the vertical's name.
Each scope is bound to a *version*, so two scopes of the same vertical can be running
different code at the same time — which is what makes previews and staged rollouts
possible at all (chapter 10). And the router does not re-check jurisdiction: residency is
pinned by configuration ahead of this worker and by the scope's DO placement below it,
and a third enforcement point here could only ever disagree with those two.

## [3] The vertical's door lets a person in

Now we are inside the vertical's own worker, an ordinary Hono app. The first thing registered
on it is the invocation log, which writes one tenant-stamped line for this request under the
request's **request id**: the id every event the request emits will carry, and the one its
response hands back in an `x-substrat-request-id` header (chapter 12). The log is first because
Hono runs handlers in registration order, and a log mounted below a route cannot see that route.

Everything between that line and the scope is the **door**. A worker no longer writes it: it
composes `workerDoor` from `@substrat-run/vertical-host` and supplies only what is its own, its
bindings, how a request routes to a `(tenant, scope)`, and its settings. The door then does the
same few things for every vertical, in order.

**It reads the asserted node.** `readRoutedNode(request.headers, { expectedSecret })`
returns `(tenantId, scopeId, surface, verticalSlug)` or throws. This is the vertical's
side of the router contract, and it lives in shared code because every vertical needs it
and none of them should re-derive how to trust it.

**It authenticates the caller.** This is where OIDC happens: a session cookie, or a sign-in
redirect to the issuer the dashboard delivered for this install, and back. The vertical is a
relying party and runs no credential store of its own. What it gets back is a subject, and,
when the issuer verified one, an email address.

**It maps that subject to a principal.** The authenticated subject is not yet an identity in
this scope. The tenant's identity directory resolves it to a `PrincipalId`, or to nothing, in
which case this person has authenticated successfully and may still do nothing at all. Chapter
6 is about that line. Three ways a person gets from "nobody" to a principal now happen here,
at the door, rather than in each vertical's own code:

- **The owner** takes the owner seat, once, with the address provisioning reserved it for or a
  claim link from the dashboard.
- **An invited person** is admitted by the address their issuer verified. The door finds the
  open member invite naming that address in this scope, and binds the login to the principal
  the invite was written for. No secret is mailed, because none is needed: the issuer's
  verification is the proof.
- **A person owned by another app** is admitted by asking that app who they are. That is the
  plugin's door, and chapter 8 follows it.

**It joins a person the first time they arrive.** If the vertical names its join operation,
`workerDoor({ join })`, the door runs it the first time a person reaches the scope, then gives
them the entity-grant shapes the vertical declares for a person's own record, once. This was
invisible locally for a long time, because the dev server's seed did it, so a deployed owner
could sign in and then create nothing. The builder studio's gates now refuse a generated vertical
that declares a join and does not name it in the door. The join must be idempotent. "First time" is remembered per
isolate, so it can run twice for one person.

The important thing about all of this is that it is the *vertical's* worker, not the kernel.
Substrat has an opinion about authorization and only a seam for authentication.
[Authentication & identity](/concepts/identity) is that seam, and the door is the one shared
implementation of it.

The same declared operations are then served three times over, with no extra declaration: as
REST routes described by an OpenAPI document, as a reference page at `/api/docs`, and as an
**MCP server at `/api/mcp`**, with one tool per operation that faces HTTP. An agent holding a
user's token can do exactly what that user could do with `curl`, behind the same door and the
same `ctx.check` inside the operation. Exposing an operation is not authorizing it. A refused
tool call comes back as a tool error the agent can read, not as a failed session.

Alongside this, the platform's own management routes are mounted in one call,
`mountPlatformSurface(app, deps)`, whose hooks the door fills. It owns every `/internal/*` route
the control plane calls to provision, reconcile, snapshot, export, restore and configure this
install, behind a platform-secret gate that fails closed when the secret is unset. Those are not
on the request path a user takes; they are how chapters 10 and 15 reach in.

## [4] Getting a scope stub

```ts
const stub = await host.getScope(principal, tenantId, scopeId);
```

`CloudflareScopeHost` is the coordinator. It is **stateless**, rebuilt per request, and it
does two things before it will hand back a stub.

**Lifecycle gates.** `validateScopeAccess(tenantId, scopeId)` is evaluated durably in the
control-plane DO. It refuses a scope that is not servable and a tenant that is not
servable — suspended, deleting, archived, reaped, or simply not in this tenant. This is
the K-3 fail-closed path, and it is where suspension actually bites. A throw here
propagates out; there is no degraded mode.

**Lazy migration.** `migrateAndRecord(scopeId)` asks the scope to bring itself to the
current migration frontier. Migrations are not run at deploy time across the fleet; each
scope migrates **on wake**, inside its own serialization domain, the first time anyone
touches it after a version change. If it throws, the coordinator makes a best-effort
attempt to record *why* into the directory — and then rethrows the original error, on
purpose, because a broken recorder must not replace a diagnosable migration failure with a
confusing one. A scope whose migration failed fails closed and serves nothing, which is
what stops it from rendering as healthy in the console.

Only then is the stub minted. **Holding the stub is the authorization to talk to that
scope** — but it is not the authorization to do anything in particular, and the scope
re-validates every call regardless.

`getScope` is also the only door that can hand an operation the address the issuer verified
for the caller, through a parameter no other door has. The operation reads it as
`ctx.verifiedEmail` (chapter 4). A door that forgets to pass it gets `null`, and an operation
that needs it fails closed rather than falling back to an address somebody typed.

## [5] Inside the Durable Object

`stub.invoke('workorder/create', input)` is an RPC into the scope's own Durable Object.
The structured-clone boundary is that RPC hop. What happens on the other side, in order:

1. **The queue.** The call is enqueued on the per-scope `OperationQueue`. It waits until
   the operation ahead of it has run to completion.
2. **The transaction opens.** Everything below happens inside
   `ctx.storage.transaction(async …)` — the DO analogue of `BEGIN IMMEDIATE`, which rolls
   back on a throw *across awaits*.
3. **The operation resolves.** A name like `workorder/create` is looked up in the module
   registry. A module whose entitlement the tenant does not hold did not register at all,
   so its operations simply do not resolve — there is no half-loaded engine and no
   operation that exists but refuses.
4. **The input is parsed.** The host applies the module's declared Zod schema before any
   guard and before the handler. Handlers do not hand-parse. This happens on *every* path
   in — HTTP, test, seed, schedule — so a declared input that nobody validates is not
   possible rather than merely discouraged.
5. **Guards run.** Manifest guards, and any concurrency precondition the caller sent
   (`If-Match` against an entity's version). Idempotency keys are resolved here too: a
   replayed key returns the original result without re-running anything.
6. **The handler runs.** Its first line is a permission check. Chapter 4 is this step.
7. **Commit, or roll back.** On success the transaction commits — the domain rows, the
   events, the links, the grants, all of it, atomically. On a throw, all of it is gone.

There is one deliberate exception to "on a throw, all of it is gone". A **permission
denial is recorded after the rollback**, as its own write, outside the transaction that
just disappeared. That is the whole point of it: the denial is precisely the write the
refused operation could not make, so keeping it inside the rolled-back transaction would
erase the only evidence the refusal happened. Chapter 6 returns to it.

## [6] After the commit

The moment the transaction commits, the DO drains its outbox to consumers, each delivery in
its own transaction and still inside this operation's turn in the queue. That is chapter 5, and
it is where most of the system's interesting behaviour lives.

Back on the coordinator, outside the scope, any executors and connectors due for the new events
run next. If the operation raised platform intents, the vertical flags its response so the
router can ask the control plane to act on them straight away (chapter 5, "the kick").

Then the result travels back out: clone boundary, coordinator, vertical worker, JSON,
router, browser.

A refusal travels the same way, as a **problem document**: `application/problem+json` with a
`code` from one closed list, the request id, and a `type` URI that resolves to a page about that
code. Every platform surface answers in that shape now, not only the ones that happened to
throw. The exceptions are bodies another specification owns, such as OAuth and JSON-RPC, and a
gate keeps that list exact. An uncaught throw becomes `internal` with no detail rather
than a text 500. When the reason came from somewhere the caller has no business reading, such as another tenant's
deployment or an upstream service, the caller gets a fixed sentence and a reference, and the
text stays where only the platform's staff can read it (chapter 13).

## What the local runtime does differently

Nothing that matters, which is the point.

Locally, a scope is a SQLite file instead of a Durable Object, the coordinator is in-process
instead of across an RPC, and there is no router — you address the instance directly with
`ALLOW_DEV_NODE`. The queue, the clone boundary, the transaction semantics, the lazy
migration, the fail-closed addressing and the stamped envelopes are the same, because the
same [conformance suite](/reference/contract-tests) runs green on both, unchanged, in Node
and in real `workerd` against real Durable Objects. Neither side is a mock.

That equivalence is what makes local development deterministic and CI cloud-free, and it
is the reason a vertical moves from a laptop to Cloudflare with no code change.

---

**Next:** [What a handler can and cannot do →](/book/04-inside-an-operation)
