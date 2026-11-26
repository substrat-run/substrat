---
id: K-72
date: 2026-11-25
layer: kernel
title: "The router reads routes from a KV read model the directory publishes"
status: proposed
aliases: []
amends: ["K-26"]
tracking: ["#3395"]
---

# K-72 — The router reads routes from a KV read model the directory publishes

> **Proposed 2026-11-25, not ratified.** It is the implementation-level answer to the cache
> question K-26 deferred to kernel open question 5, for routing. The bound it is held to is not
> decided here: it is **[D-77](./D-077-routing-changes-and-suspension-take-effect-within-five-minutes-through-the-edge-read-model.md), "Routing changes and suspension are designed to take effect within five
> minutes, through the edge read model"**, proposed in the data-at-scale RFC
> ([#3396](https://github.com/substrat-run/substrat/pull/3396)). The owner's choices are listed at
> the end, and [#3395](https://github.com/substrat-run/substrat/issues/3395) has the measurements.

**The control plane's directory object leaves the request path.** The directory publishes what
the router needs to Workers KV, and the router reads memory → KV → the directory. The directory
answers every miss, and its answer is the one KV catches up to.

**What is published, split by how it changes.**

- A **route** per hostname (`route/v1/h/<hostname>`): tenant, scope, vertical, surface, the
  scope's hostnames, whether the scope is the real install (#2005), and a dispatch pointer. It
  changes when a hostname, a scope's binding or a lifecycle status changes.
- A **serving policy** per vertical (`route/v1/v/<slug>`): the outbound hosts, peer calls and
  scope stores of the version the vertical's stable script runs (K-33, D-46). A promote moves this
  one key and no route. A scope still on a per-version script carries its version's policy inside
  its route, because that policy never changes for the version.
- A **refusal** for a hostname that is active itself while its scope or tenant is not. The router
  refuses it from KV, so a suspended tenant's traffic does not fall back to the directory. A
  hostname that is not active itself has no entry, so a newly activated one is answered by the
  directory at once rather than refused from an edge cache.

**Capture is a mechanism.** SQLite triggers on the five tables the route read joins append every
affected key to an outbox in the same transaction as the change. The directory drains the outbox
when the last of its running methods returns, so it never reads a transaction that has not
committed, and one flush at a time. It writes to KV only when an entry's digest changed, and the
ledger records a write as uncertain until KV has accepted it. The
scheduled pass reconciles a slice of every key against the ledger of what was published, and a
restore re-publishes everything, deleting what the restored directory no longer routes. The
triggers only append, so none of them can fail a directory write.

**One writer for every source.** `writeRouteReadModelEntry` is the only code that writes the
namespace. It compares an entry's digest with a ledger the source keeps and moves the ledger only
after KV accepted. `routeEntryOf` and `servingPolicyEntryOf` build an entry from a source's own
fields, residency rule included. The one directory is the only source today. When it splits into a
registry and per-tenant objects (K-68, directory split), each calls the same three, so the entry
shapes cannot differ between sources and the router does not learn that the source moved.

**Residency (K-36).** No residency-pinned hostname's name appears in any KV value. A route whose
hostname region or scope jurisdiction pins storage (`eu`, `us`) is never written to KV, which has
no jurisdiction. Neither is the route of an unpinned hostname whose scope also holds a pinned one,
because a route's value lists its scope's hostnames. The router reads both from the directory, as
before. Every production route is unpinned today.

**Suspension needs no new mechanism.** The read model enforces suspension and removal on its own:
a suspended tenant's routes become refusals in KV, and the router refuses them without a per-request
status read, aiming at D-77's five-minute target. Separately, and already built, the platform delivers each scope's
lifecycle into the scope (#1713), and the CP-less host's `assertLive` refuses at every door, the
request's `getScope` included, once that delivery lands. This record adds nothing to that path and
relies on it for nothing. Where it exists it simply refuses first.

**The cache split, the cheapest inside D-77's five minutes.** The owner ranks request latency and
cost above freshness. KV bills every read, so the router keeps an entry 180 s in memory, and an
isolate reads a route and its vertical's policy at most once each per 180 s. KV is read with its
default `cacheTtl` of 60 s. A negative answer (no entry, and the directory routes nothing) is kept
60 s.

| Change | First stopped by | Router read model |
|---|---|---|
| Tenant or scope suspended | the scope, once its lifecycle delivery lands (made right after the transition; typically under a second), where the vertical's kernel has #1713 | ≈ 4 min: publish (under a second), KV's edge cache (60 s), memory (180 s) |
| Suspension lifted | the scope, on delivery | ≈ 4 min (the refusal is cached the same way) |
| Hostname removed | the router | ≈ 4 min |
| Hostname activated | the router | a name with no entry (new, or deactivated before): at once, or ≤ 60 s for an isolate that asked for it in the minute before. A name whose last entry was a refusal (its scope or tenant held) waits like a lifted suspension, ≈ 4 min |
| Promote | new code serves on upload (K-33) | its policy ≈ 4 min behind; the previous version's policy meanwhile |

These are estimates, not guarantees. The minute left under five is KV's own margin: Cloudflare
documents propagation as "60 seconds or more", it was not measured here, and a late propagation
makes the router's time longer. They also count the publish as under a second, which holds while
KV accepts writes. A key KV refuses goes to the back of the queue, so it never holds back the
changes behind it, and is retried every 10 s (`ROUTE_PUBLISH_RETRY_MS`). Its own change is late by
however long KV keeps refusing, and no bound covers that. D-77's five minutes is a target, and an
operator relying on a suspension or a removed hostname with the router `on` should read it that way.

**Cost.** A request whose entries are not in memory costs at most two KV reads (the route and,
on a stable serving script, the vertical's policy) at $0.50 per million reads, so the ceiling is
**$1.00 per million requests** whatever the TTL. Below the ceiling, a hostname receiving `r`
requests a second in one isolate costs about `2 / (r × TTL)` reads a request:

| Requests/s per isolate and hostname | 5 s memory (the ≈ 40 s setting) | 180 s memory (default) |
|---|---|---|
| 0.1 | $1.00 / M (every request misses) | $0.056 / M |
| 1 | $0.20 / M | $0.0056 / M |
| 10 | $0.02 / M | $0.00056 / M |

Today's traffic (0.19 requests/s across about 30 colos and 24 scopes) misses nearly every time at
either setting, which is about $1 per million requests, under $0.50 a month. The TTL is what keeps
the cost from growing with a hot tenant. Publishing writes only on change ($5 per million writes).

**Rollout.** The router's `ROUTE_READ_MODEL` is `off` (default), `compare` (serve from the
directory, log every disagreement and miss) or `on`. The control plane's binding and the backfill
ship before the router reads.

**Peer-call answers (follow-up, behind their own switch).** A peer call's directory read
(`peerCallTarget`: may this caller call that vertical, and which instance answers) is published
too, as `route/v1/c/<tenant>/<caller scope>/<caller vertical>/<target>`, by the same writer and
ledger. Only an answer the router would **dispatch** is published. Every refusal has no entry and is
the directory's, read at the call: a caller that is not live, not primary or not that vertical, a
target that is not installed, ambiguous, bound to a gone instance, undeployed, or the caller itself.
A target on a stable serving script takes its outbound hosts and calls from `v/<slug>`, so a
promote moves no peer entry. An answer is published only after a router asked for it, so there is
no backfill, and the triggers on the tenant's rows re-dirty only that tenant's published or queued
answers: with no router asking, they append nothing. Neither scope may be residency-pinned (K-36):
a caller or target whose jurisdiction pins storage, or which holds a pinned hostname, is answered
by the directory.

The bound is the routes' split. A **revocation** (the caller or its tenant suspended, the target
suspended, the binding moved, a second instance installed) reaches a router that read the answer
in about four minutes, inside D-77's five. The gates that read only the dispatch parameters (the
chain's depth and the caller's declared `calls`) never read the read model, and neither does the
target's door (#1714), which decides what the peer may do. Where the vertical's kernel has #1713, a
suspended scope refuses at its own door first, whichever side of the call it is on. Where it does
not, the router's check is the line, and it holds within the same four minutes. No check on this
path needs a tighter bound than D-77's, so none was kept on the directory. A grant of new reach (a suspension lifted, a target installed) is never held up by
the edge, since no refusal is published; the directory answers it, and an isolate keeps a refused
answer 60 s. Store calls need nothing: the stores a call may reach come from the dispatch
parameters the route set, so they already follow `ROUTE_READ_MODEL`.

The router reads peer answers only under `PEER_READ_MODEL` (`off` by default, `compare`, `on`),
not `ROUTE_READ_MODEL`, because routes already read the read model in production and sharing their
switch would move every peer call at deploy. In `compare` the directory serves and is asked to
publish, since an answer exists only once asked for.

## Why

**The object cannot be on every request at the target scale.** One single-threaded object, in one
place: a router in Sydney paid 290 ms at p50 to resolve a route in Madrid, and every tenant added
moves its requests onto that object. KV is read at the edge, and with a 180 s memory TTL most
requests to a busy hostname read nothing at all.

**Freshness was the half K-36 left, and D-77 settles how much of it is needed.** K-26 deferred the
cache because a cached route that keeps serving a suspended tenant blunts suspension. Five minutes
is the owner's answer. A gate per request was not built because the bound does not need one.

**Triggers, because a list of call sites rots.** The route read joins five tables written from
dozens of directory methods. A hand-placed "publish here" would miss the next method someone adds.
A trigger cannot be forgotten, and the parity suite checks the read model against `readRoute`
after every kind of change.

**The ledger is not directory data.** It records what KV holds, so a dump does not carry it and a
restore keeps it. That is what lets a restore delete the routes the restored directory no longer
has, which a ledger restored from the dump would have hidden.

## Considered

- **A router fill on a miss** (the router writes what the directory answered). It races a
  suspension: the router reads "active", the directory suspends and deletes, and then the router
  writes "active" back. The router asks the directory to publish instead, so the directory stays
  the only writer.
- **A jurisdiction-pinned D1 replica or per-jurisdiction cache objects** (K-36's options). They
  are residency-safe but add a store per jurisdiction while no pinned route exists. Kept as the
  answer for pinned routes when the first one does.
- **Negative entries for unknown hostnames.** A probe of random names would grow KV without
  bound. Unknown names are remembered in memory only, for 60 s.
- **A scope-local suspension flag built for this.** Not needed under five minutes. The #1713
  delivery already refuses in the scope, and nothing here depends on it.

## Relation to other records

- **K-26**: answers its deferred cache question for routing, and amends it. A cached route may
  serve a suspended tenant at the router for about four minutes.
- **[D-77](./D-077-routing-changes-and-suspension-take-effect-within-five-minutes-through-the-edge-read-model.md)**
  ("Routing changes and suspension are designed to take effect within five minutes, through the
  edge read model", proposed): the bound. This record is its routing mechanism and does not
  restate it.
- **D-41**: entitlements stay projected into scopes. Routing and suspension are settled at the edge,
  as D-77 says.
- **K-36**: KV stays foreclosed for residency-bound routes, and they are not published.

## Open choices for the owner

- **The bound and the split.** 180 s in memory plus 60 s of KV edge cache, about four minutes in
  all, inside D-77's five. Shorter costs more KV reads (the table above). The constants are
  `ROUTE_MEMORY_TTL_MS`, `ROUTE_NEGATIVE_TTL_MS` and `ROUTE_KV_CACHE_TTL_S`
  (`packages/adapter-cloudflare/src/route-read-model.ts`).
- **Peer-call answers** read the directory on every call (~5,000 a week) until
  `PEER_READ_MODEL` is turned on: `compare` in test, then prod, then `on`. Store calls follow
  `ROUTE_READ_MODEL` already.
- **When to turn it on:** `compare` in test, then prod, then `on`, after the backfill reports an
  empty outbox.
