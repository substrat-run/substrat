# A store read from inside a scope

Evidence for [#3370](https://github.com/substrat-run/substrat/issues/3370), the phase 1 spike of
[the one-model RFC](../../docs/rfc/one-model-for-shipped-code.md) (§7.2) that may reopen
[K-64](../../docs/decisions/K-064-a-scope-has-a-declared-type-and-may-have-a-parent-and-nothing-crosses-a-scope-s-boundary-inside-its-transaction.md)
for reads, and for [#2258](https://github.com/substrat-run/substrat/issues/2258). Not a workspace
member: nothing here is imported by a package, and the root `pnpm-lock.yaml` does not name it. The
lockfile in this directory is its own.

It asks three things:

1. Can a scope's Durable Object call its store through a policed path, and not a raw binding?
2. Does the scope stand still while the store answers, and for how long?
3. What does a read from inside the scope cost, compared with host code making the call?

**The short answers.** (1) Yes, but not through egress: through a capability the router mints
and hands to the dispatch. That path works from inside the object. Whether it is limited to its
request on a real dispatch namespace is not shown here, and it matters. (2) Yes. Awaiting
anything inside `ctx.storage.transaction` holds the whole object until the transaction ends, and
that is workerd, not our queue. Every call behind a read waits for the store's whole answer time.
(3) Locally the paths are within noise of each other one call at a time. The difference is in
what the scope's other callers pay. **K-64 stands as written. No read exception is
recommended.** Details under [What it means](#what-it-means).

## Run

From this directory, with Node and pnpm (the repo's `packageManager` is `pnpm@10.10.0`):

```
pnpm install --ignore-workspace
node run.mjs            # 12 checks, then the measurements (about 2 minutes)
node run.mjs --checks   # the checks only
```

A failed check sets a non-zero exit. pnpm may warn that it ignored workerd's build script; the
binary comes as an optional dependency, and the run does not need the script.

## Method

Four workers in one miniflare (4.20260730.0, workerd 1.20260730.1):

| Worker | Stands for | File |
|---|---|---|
| `router` | The router. It sets the caller (tenant, vertical, scope, declared stores) and dispatches. It exports `StoreCalls`, today's store entrypoint, and `StoreDoor`, the candidate door | `src/router.mjs` |
| `egress` | The egress worker's store half. The vertical's global `fetch` goes here (`outboundService`), and a `store.substrat.internal` call is handed to `StoreCalls` | `src/egress.mjs` |
| `vertical` | A vertical: a worker entrypoint (host code) and its `ScopeDO` | `src/vertical.mjs` |
| `store` | A scope store object. `read` answers a payload of the asked size after the asked delay | `src/store.mjs` |

`ScopeDO` runs each operation as `packages/adapter-cloudflare/src/scope-do.ts` does: on a
per-scope `OperationQueue` (copied from `serialization.ts`), inside
`ctx.storage.transaction(async …)`. The modes:

| Mode | Where the store read happens | Path |
|---|---|---|
| `local` | No read. One insert | none |
| `inside-raw` | Awaited inside the operation's transaction | a Durable Object binding to the store script, held by the vertical. A hosted upload carries none |
| `inside-door` | Awaited inside the operation's transaction | `StoreDoor`, the router's capability, passed into the object as an RPC argument |
| `inside-fetch` | Awaited inside the operation's transaction | the object's own `fetch` of `store.substrat.internal` |
| `host-door` | In the worker, between two operations | an `attempt` operation, then `StoreDoor`, then a `record` operation |
| `host` | In the worker, between two operations | `attempt`, then `fetch` through egress and `StoreCalls`, then `record`: K-64's shape |

**`StoreDoor`.** The router makes it with `ctx.exports.StoreDoor({ props: caller })`. On Workers
for Platforms the router would hand it over in the dispatch's
[dynamic dispatch `props`](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/#give-access-to-specific-platform-functions).
Miniflare has no dispatch namespace, so the router passes it as an argument of an RPC call to the
vertical. The vertical can call `read(binding, input)`. It cannot read or change the props, so the
scope it reaches is the router's, not one the vertical names. A binding the version does not
declare is refused in the router.

**What is not like production.** The router reaches the store with a direct binding. It does not
sign a K-52 envelope or go through the dispatch namespace, because that hop is the same for every
mode and is not what is compared. The egress worker's caller is a fixed binding, because miniflare
has no dispatch parameters. In local workerd the vertical's `outboundService` covers its Durable
Object too, so `inside-fetch` passes egress here. On Workers for Platforms it does not
([below](#1-a-policed-path-from-inside-the-object)). Everything runs in one process on one machine.

**The gate probe** (`/gate` in `src/router.mjs`) is ordered by a handshake, not by time. The
store holds the first call's read until the router releases it. The router waits until the store
reports the read held, then sends the second call and gives it a second to finish. Then it
releases the read through the store, a path independent of the scope. The results are whether the
second call finished while the read was held, and the rows left behind. Latency is not part of
any check.

**Timing.** The measurements are timed inside the router with `Date.now()`, which in workerd
moves across I/O, and only I/O is timed. That leaves out the miniflare proxy between Node and
workerd, which added 100–300 ms per call in a first run timed from Node. The store's delay stands
for the time a real store takes to answer. It is the input of the experiment, not a platform
constant.

**Load.** The machine was an Apple M2 Pro shared with other work. The tables are from run 5
(2026-11-24), at a load average of about 28. Two earlier runs, at about 120 and 150, had the same
shape with numbers 2–7× larger. Their timing of "all reads done" could include time waiting for the
local operations; run 5 times it separately.

## Findings

### Checks

All 12 pass. Each is a line in `run.mjs`.

| Check | Result |
|---|---|
| Each of `inside-door`, `inside-raw`, `inside-fetch`, `host`, `host-door` answers a 1 KiB read | Yes |
| `StoreDoor` refuses a binding the version does not declare | Yes, in the router, before the store |
| An operation that throws after its read rolls back its writes | Yes |
| `StoreCalls` refuses a scope other than the dispatch's | Yes |
| Locally, a `ctx.exports` door kept past its request still answers in a later request | **Yes** |
| Locally, the same kept door answers in an alarm | **Yes** |
| Inside `storage.transaction`, **with no queue**, a second call cannot finish while the first awaits the store | **Yes**: with the read held, it did not finish in a second. It ran once the read was released, and its write landed after the first call's rollback, not inside it |
| With no transaction, the input gate lets that second call run and finish while the first awaits the store | Yes: it finished with the read still held, and its write fell between the first call's two |

### One call at a time

Milliseconds, run 5, timed in the router, warm, store delay 0. 200 calls per cell (50 for 1 MiB).
`Date.now()` has 1 ms steps here.

| Mode | 1 KiB p50 | 1 KiB p95 | 64 KiB p50 | 64 KiB p95 | 1 MiB p50 | 1 MiB p95 |
|---|---|---|---|---|---|---|
| `local` | 0 | 1 | 0 | 1 | 0 | 1 |
| `inside-raw` | 0 | 1 | 0 | 1 | 1 | 1 |
| `inside-door` | 0 | 1 | 0 | 3 | 1 | 6 |
| `inside-fetch` | 0 | 1 | 1 | 2 | 3 | 7 |
| `host-door` | 0 | 1 | 0 | 1 | 1 | 5 |
| `host` | 1 | 2 | 1 | 2 | 4 | 10 |

In one process every hop is a little copying, so this table says only that nothing here is
expensive, and that the egress path (`host`) is the dearest by a few milliseconds per MiB. The
order changed between the loaded runs, so no ranking holds locally. What a hop costs on the edge
is not measured here (see [Not shown](#not-shown)).

### Reads and local operations at once on one scope

R reads of one mode started together on one scope, then 2 ms later 20 `local` operations on the
same scope. Milliseconds, run 5.

| Scenario | Mode | Local op p50 | Local op max | All reads done |
|---|---|---|---|---|
| 20 reads, store answers in 10 ms | `inside-raw` | 257 | 259 | 259 |
| | `inside-door` | 256 | 257 | 257 |
| | `host-door` | 4 | 4 | 17 |
| | `host` | 2 | 4 | 22 |
| 20 reads, store answers in 50 ms | `inside-raw` | 1 047 | 1 048 | 1 048 |
| | `inside-door` | 1 059 | 1 060 | 1 060 |
| | `host-door` | 10 | 16 | 68 |
| | `host` | 16 | 17 | 71 |
| 50 reads, store answers in 10 ms | `inside-raw` | 631 | 632 | 636 |
| | `inside-door` | 653 | 654 | 656 |
| | `host-door` | 3 | 3 | 54 |
| | `host` | 2 | 3 | 54 |

With the read inside the transaction, the reads run one after another, and a local operation
finishes when the last read sent before it does. The floor is the reads times the store's delay
(20 × 50 ms = 1 000 ms, measured 1 047–1 059). On either host path the reads run side by side, so
all of them answer in about one store delay. A local operation waits only for the queued `attempt`
and `record` operations, never for the store (2–16 ms). The two loaded runs had the same split:
local operations waited 0.4–7.5 s behind reads inside the transaction and 0.01–0.6 s behind
host-path reads.

Large reads (10 × 1 MiB and 10 × 4 MiB, store delay 0) are in `run.mjs` too. In run 5 every path
finished them within about 100 ms, and their order changed between runs. Locally a payload moves in
about a millisecond, so a large read with a store that answers at once holds the object for very
little. On the edge it holds it for the transfer as well.

## What it means

### 1. A policed path from inside the object

- **Egress cannot be that path.** Cloudflare's
  [Outbound Workers page](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/#requests-that-outbound-workers-do-not-intercept)
  lists requests "From Durable Objects" among those an outbound worker does not intercept. That is
  #2258's limit, and `apps/vertical-egress/src/worker.ts` already records it. On a real namespace a
  `fetch` of `store.substrat.internal` from the object fails, because no DNS zone has the name
  (`packages/contracts/src/scope-store-transport.ts`). This spike's `inside-fetch` passes only
  because local workerd routes the object's `fetch` through the outbound service too. Local runs
  cannot show this limit.
- **A raw binding is not policed.** It is what the scope-stores RFC removed from hosted uploads
  (§10.1): code holding it can address any name the namespace reaches.
- **A router-minted capability is a policed path, and it works from inside the object.** The
  router decides the caller and the declared bindings, and the vertical cannot change either.
  This spike shows that the door can be passed into the object and called inside its transaction,
  and that it refuses an undeclared binding. It is the
  [pattern Cloudflare documents](https://developers.cloudflare.com/durable-objects/best-practices/architecture-examples/)
  for a platform object reached from a user worker. It would sign the same K-52 (or K-67) envelope
  `StoreCalls` signs. Egress is then not in the path at all, and it does not need to be.
- **Its lifetime is the open question.** Cloudflare says a stub passed through dynamic dispatch
  props "is valid only during the request that received it". Locally, a `ctx.exports` stub that the
  object kept answered in a later request and in an alarm. Miniflare has no dispatch namespace, so
  the documented rule is not what ran. Either way, the door must not rely on its lifetime for
  policy. If it is limited to the request, a schedule still has no path, and #2258's schedule half
  stays open. If it is not, the door is a standing capability the object can keep, and its own
  check must carry an expiry and the serving version.

### 2. The stall is workerd's, not our queue's

The gate probe takes `OperationQueue` away and keeps the transaction. A second call, sent while
the first call's read is held, still cannot finish until the read is released. Without the transaction, the input gate lets it in while
the first call awaits. So with any path, a store read awaited inside the operation's transaction
holds the scope for the store's whole answer time. Removing or loosening our queue would not
change that. Holding it is also the safe behaviour: had the second call run inside the open
transaction, its write would have gone with the first call's rollback.

That gives K-64's "nothing crosses a Durable Object's boundary inside a transaction" a measured
reason beyond the argument it makes. **Each read inside the transaction adds its full answer time
to every call queued behind it.** For a production sense of scale, the
[store-facets spike](../store-facets/FINDINGS.md) measured a warm call to a graph store object on a
real namespace at 3–8 ms, and a cold start at 2.1–3.1 s. A cold store therefore holds the scope
for seconds, and so does a read of a whole revision while it transfers. The host path holds the
scope for the `attempt` and the `record` only.

A read made in the object outside the transaction, before the operation, would not hold the
scope: the input gate opens. But its answer is no more consistent with the operation than a read
made by host code, since no snapshot spans two objects. That is K-64's path with the call made
in a different isolate, and the door's lifetime question applies to it unchanged.

### 3. For K-64 and #2258

- **K-64's rule stands for reads as written.** A read inside the transaction stalls the scope for
  the store's answer time, on any path, and the stall is the platform's. The revisit condition,
  "a store read from inside a scope is cheap and passes a policed path", holds for the path half
  only. No narrow exception is recommended.
- **What a read costs on the K-64 path** is one operation, to check the key and mint the proof,
  plus the store call from host code. A read that writes nothing needs no `record` operation.
  Locally that costs about what a read inside does, one call at a time. On the edge the difference is one
  worker-to-object round trip. Whether that object is in the same place as the worker is the
  one number this spike does not have.
- **For #2258 the door is the candidate**: a capability the router mints, rather than egress,
  which can never see the object. It serves calls from host code too, so egress could be left out
  of store calls altogether. Whether it can also serve a schedule depends on its lifetime on a real
  namespace.
- **The second load in #3370** (large reads of whole model revisions, many reads behind one page)
  is the case where a read inside the transaction costs most, since the scope is held for the
  transfer as well. On the host path it holds nothing. A cache for those reads belongs in host
  code or the store, not in the scope's transaction.

## Not shown

Each of these needs a real dispatch namespace, which this run did not use:

- whether a stub handed over in dynamic dispatch `props` can be passed into the user worker's
  Durable Object, and whether it then lasts beyond the request;
- what the door hop and the egress hop each cost on the edge, and how far a worker is from its
  scope's object;
- billing: who pays for the time a scope is held.
