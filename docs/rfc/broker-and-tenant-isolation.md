---
status: proposed
layer: kernel
description: "Everything that leaves a scope, and how a tenant's code is kept apart from another tenant's while it runs. A broker per (tenant, app) owns delivery after commit and replaces the pending-intent cap, the drain kick and the 15-minute pass; scopes become facets loaded per (release, tenant, app) with no network of their own; a write that waits on an outside answer becomes a kernel process that holds the entity it addresses; outbound calls leave through a policy gate and the platform's outbound worker, which is the only place a credential is injected. Four tracks with different risk, decided and built separately. Track A is buildable now; B needs spikes; C and D wait for B and a consumer."
---

# RFC: one broker per app, scopes as facets, and a kernel that waits outside the queue

**Status: proposed.** Design only. Nothing here is built. It proposes decision records, all
`proposed`, numbered on merge (`lint:decisions` refuses gaps, so no number is reserved here). They
wait for the owner. It builds on [one-model-for-shipped-code.md](./one-model-for-shipped-code.md)
(the model as the source of code), [tenant-scale.md](./tenant-scale.md) (K-69, K-70, D-79) and
[D-70](../decisions/D-070-a-store-driver-s-code-runs-in-its-own-loaded-isolate-outside-the-verifier-with-no-network.md)
(loaded isolates and facets for store drivers), and it rewrites parts of K-6, K-62, K-64, K-69,
D-46, D-58 and D-64, listed in §11.

The proposal is four tracks, not one change. They carry very different risk, and each is decided
and built on its own (§3). Read §3 first if you read only one section.

## 1. The problem

A tenant's data lives in scopes. Each scope is a Durable Object with its own SQLite, and the kernel
runs a scope's operations strictly one at a time (K-6, `OperationQueue` in
`packages/adapter-cloudflare/src/serialization.ts`). The queue is what keeps an operation from
seeing another's half-finished writes. It also means an operation that waits blocks every other
operation on the scope.

An operation that touches only its own scope is simple. Everything else is not: data from another
app, an answer from an outside service, an event other apps should receive. None of it can happen
inside a transaction, because a transaction cannot span two Durable Objects or wait on the network
(K-62, K-64). The mechanisms for that grew one at a time and do not form one design:

- **Outgoing work.** A scope's platform intents wait in `_substrat_platform_requests`, capped at
  `MAX_PENDING_PLATFORM_REQUESTS = 32` (`packages/contracts/src/platform-request.ts`), with routed
  connector deliveries in a room of their own of the same size (`MAX_PENDING_CONNECTOR_DISPATCHES`,
  `packages/kernel/src/platform-request-cap.ts`, #3365). Its outbox rows wait for the lake drain
  (`_substrat_outbox.drained_at IS NULL`). Both used to leave only on the control plane's
  `*/15` pass. `scope-wake.ts` (K-69 step 4) now lets a scope arm its alarm after a commit and kick
  the control plane's drain, phase by phase behind `SCOPE_WAKE_PHASES`. That is the right
  direction, and the control plane is still the only drainer. A large import still arrives in
  batches bounded by the cap, and the cap is a refusal callers have to route around (`runPurgePass`).
- **A call that waits for an answer.** K-62's committed attempt is the pattern: commit an attempt,
  call from host code, record the answer in a second operation. It is built by hand for one engine.
- **A read that needs data from several apps.** There is no ordered form. The logic ends up in the
  worker, or the read blocks the scope's queue while it waits.
- **Calls to the internet.** The outbound worker admits only declared hosts (D-46). Cloudflare does
  not route Durable-Object-originated subrequests through it, so code running in a scope is not
  policed. It is observed (D-58), not refused.
- **Tenant isolation while code runs.** Each scope has its own storage, but Durable Objects of one
  class may share an isolate, so two tenants' code may share JavaScript memory.
- **Credentials.** A first-party connector runs in the control plane and its credential never
  leaves the platform. A vertical-defined connector (D-64) receives the plaintext in every call
  (`docs/architecture/vertical-connectors.md` §3: "the vertical holds the plaintext").

And the target says code is generated from the model, so processes, steps and telemetry have to be
traceable to the model too.

## 2. Three ways to communicate

The useful question is who waits for the answer, and where. Whether the call reads or writes
matters less.

| Pattern | Who waits | Example |
|---|---|---|
| **Request-response** | The caller holds the connection until the answer | An operation answering 200 |
| **Request-reply** | Nobody holds a connection. The answer arrives later as its own message, carrying the request's id | A booking that must ask billing before it can be confirmed |
| **Publish-subscribe** | Nobody waits, and the sender does not know who listens | "Order placed" reaching both stock and invoicing |

The middle row is the hard one. An operation that needs another app's or an outside service's
answer must not hold the scope while it waits. It has to hand the question off, release the scope,
and continue when the answer comes. In practice request-reply is often a request-response that did
not finish in time: answer 200 if it completes within a few seconds, otherwise 202.

AsyncAPI 3 describes channels, messages and request-reply, as OpenAPI describes HTTP. Substrat
generates the contract from what an app declares and never writes it by hand (D-29, D-76).

## 3. Four tracks

| Track | What | Risk | When |
|---|---|---|---|
| **A. Broker** | Outbox → broker per (tenant, app) owns delivery. Replaces the caps, the drain kick and the pass | Low. Runs on today's scopes, needs no facets | Now |
| **B. Facets** | Scope and broker code in an isolate per (release, tenant, app), with no network of its own | High, and the most valuable | Spikes first (§6.5), then the data-move design |
| **C. Segments and processes** | The kernel releases the queue while an operation waits; a write that waits becomes a process | Changes K-6 and K-62 | When a concrete waiting write needs it |
| **D. Egress and credentials** | Policy gate, credential injection in the outbound worker, a write-only door, connectors as structure | Security surface | Its own decision, after B |

Independent of all four, and buildable now:

- **Sealing the lake's payloads** (§9.2). K-37's limit 6 is a gap today and needs no broker.
- **Binding a credential to its host** (§8.3) can be decided now, though injection waits for B.

Every track holds one rule from the start: **the pure SQLite host has a counterpart.** Dev, CI,
self-host and escrow run on `adapter-sqlite`, which has no facets, no Durable Object broker and no
outbound worker. Whatever becomes contract gets an in-process implementation there and a shared
suite in `packages/contract-tests`, as K-6 itself does.

## 4. Track A: the broker

### 4.1 Handoff

An operation writes its message to the scope's outbox in the same transaction as its data. That is
the only way for the message to commit with the data. Right after commit the scope hands the message
to the broker. The broker stores it and acknowledges; from that moment the broker owns it. A failed
handoff is retried from the scope's alarm (`scope-wake.ts` already arms one after a commit that
leaves work), and the broker drops duplicates by message id. A pass is the last resort for a
platform bug, never the delivery path.

### 4.2 One broker per (tenant, app)

A broker per tenant would put all of a large tenant's traffic through one object that takes one
call at a time. Per (tenant, app) the load divides naturally, and the broker can live in the app's
own script so the handoff is a direct call. Its throughput under a large import is measured before
it replaces the pass (§13).

### 4.3 Broker to broker

The sending broker knows the subscribing apps from the installation. It hands the message through
the router to the receiving app's broker, which knows which of its scopes should have it and
delivers locally, the way a mail server hands off to the receiving server. Every hop acknowledges
and drops duplicates.

**Delivery semantics, stated precisely.** Dedup at every hop gives *effectively once* inside the
platform: a consumer's effect is applied once per message id. Toward the internet it is *at least
once*, with an `Idempotency-Key` the kernel sets so the receiver can recognise a repeat. The RFC
does not promise "exactly once end to end".

### 4.4 Request-reply

The sending broker records who waits for the answer (scope and process) and a deadline. When the
answer arrives it pairs it with the request and hands it to the kernel's `process/resume`. A late
answer is refused and logged, never applied, as K-62 already requires.

### 4.5 Ordering

No order by default. Order holds only where declared, and then per key: the sender names the key
(an order id), the receiver's subscription asks for order. The broker keeps one lane per
(receiver, key). A message stuck on order 17 stops only order 17 at that receiver.

### 4.6 Retries, pause and dead letter

| Who | Decides |
|---|---|
| The sender, per message type | Time to live, whether a repeat is safe, the ordering key |
| The receiver, per subscription | Attempts, backoff (growing, with jitter), whether order is required |
| The platform, undeclared | The pause per receiver; which failures retry (5xx, timeout) and which fail at once (4xx, schema) |

**Pause (circuit breaker).** After a run of failures to one receiver the broker stops sending, then
sends one probe after a while and resumes on success. Paused messages spend no attempts. `429` and
`Retry-After` mean slow down, not failure.

**Dead letter.** A message the broker gave up on is kept 14 days at the tenant's broker, visible to
the tenant's admin and to the platform, and can be resent or discarded. Subject erasure reaches it.

All of it appears in the generated AsyncAPI contract. The defaults cover the normal case.

### 4.7 What it replaces, and the rollout

The broker replaces both caps as refusals, the drain kick's role as the delivery path, and the
pass. It does not replace `scope-wake.ts`: the scope's alarm stays as the retry for a failed
handoff. Rollout follows the pattern of `DIRECTORY_MIRROR`: the broker first runs in shadow behind
a per-tenant switch, delivering beside the existing drain to a recorder, and the two are compared;
then a tenant is switched; then the old paths are removed once every tenant is switched. The lake
becomes one subscriber (§9.1).

## 5. Track C: operations that wait

### 5.1 The observation

What blocks a scope is the kernel's queue, not Cloudflare. A Durable Object is gated only around its
storage calls, and the kernel deliberately serialises more strictly than the input gate
(`serialization.ts`). So the kernel can split an operation into **segments**: a segment runs in the
queue, and waiting happens outside it, between segments.

This is a change to K-6, which is contract semantics on both adapters, and to K-62, which declined a
request/response verb in `OperationContext`. Both are stated as such in §11.

### 5.2 Reads

Locking the scope for the whole call is not the default. It puts every other operation behind the
remote's latency, and it deadlocks as soon as dependencies form a cycle: A holds its queue and calls
B, B's operation reads from A and queues behind A, and both wait out the timeout. Instead:

- **Local, then outward.** Segment 1 checks the permission and reads everything local, then
  releases the queue; the remote answers are fetched and merged; the read answers 200. The local
  data is from one moment with no rerun.
- **Outward, then local.** The remote answer decides what to read; again one local segment.
- **Local, outward, local.** Only here does the kernel compare the scope's revision before and after
  the wait and rerun the local parts, reusing the remote answers, at most three times. The fallback
  after the third is cheap: with the remote answers cached nothing waits any more, so all local
  parts run in one queue slot with no network. If that rerun would need remote requests the cache
  does not hold, the read answers a retryable error (409 or 503), never a guess.

A read never answers 202. Between apps there is no common moment, today or after, because no
transaction spans two apps.

An explicit "hold the scope for this call" may exist as an opt-in if a real case appears. It then
carries a short deadline and is refused where the other party is on a dependency cycle.

### 5.3 Writes: processes

A write cannot rerun from the start, since what it committed would be done twice. A write that needs
an outside answer becomes a **process**: steps, each committed on its own, with the process's
progress saved. On reaching an outward call it writes the message to the outbox in the same
transaction as the step's data, with a request id and a trace id; the broker delivers it; the answer
reaches `process/resume`, which finds the process, records the answer and runs the next step. This
is K-62's attempt pattern made general.

### 5.4 200 or 202

A process waits a short while by default (say 5 s). Done in time, it answers 200 with the result.
Otherwise 202 with a trace id and a status URL. Nothing is lost, since the process is saved. The
caller may ask for 202 at once with `Prefer: respond-async`, or change the wait with
`Prefer: wait=N`. Live reads tell a surface when the result exists; the generated client can hide
202 entirely.

### 5.5 Isolation between processes: entity holds

A saga gives atomicity through compensation and no isolation. While a booking waits on billing,
another write can move it, cancel it, or start a second confirmation; another reader can build on a
reservation that is later compensated away. Locking the scope for the wait is not available: the
wait can be minutes, or days with an approval in it. The rule:

> **A write with an outside dependency holds the entity it addresses until its process completes or
> the hold expires. Conflicting writes on that entity are refused. Reads never hold.**

- **The hold is derived.** The kernel already knows the entity an operation writes
  (`permission: { entity, idFrom }`) and that it has an outward dependency (it is declared). The
  author writes nothing. `holds: [...]` is needed only for entities beyond the one addressed.
- **The hold is a marker in the scope's database**: entity id, process, expiry, checked by the
  kernel before every write. Not an SQLite lock: SQLite has none per row, and the queue already
  serialises inside a transaction. It survives the scope sleeping. The expiry frees a stuck process
  and breaks deadlock between processes.
- **The lifecycle decides what conflicts.** The entity stands in a waiting state
  (`pending_billing`); writes the lifecycle admits in that state pass, others get 409. It builds on
  `assertTransition` and `lint:lifecycle-writes`.
- **The version is checked on resume.** If the entity changed since the step that took the hold,
  the process takes its failure path instead of overwriting.
- **Steps carry only ids and the answer forward**, and read fresh.
- **A read sees the waiting state.** That is not a dirty read: the state is in the data, and a
  screen can show "waiting for billing".

The outside resource is never held: it is not ours. It is covered by the `Idempotency-Key`, by the
service's own reserve-and-confirm where it has one (authorise and capture), and by "needs action"
on an uncertain outcome (§5.6).

### 5.6 When a process fails

Committed steps cannot be rolled back as one transaction, so a process is a **saga**: a step with
effects may declare a compensating step, and the kernel runs compensations in reverse order. Where
possible the first step is a reservation with a deadline and only the last step confirms
(Try-Confirm/Cancel), so a failure lets the reservation lapse on its own. An uncertain outcome from a
service where a repeat is not safe is never guessed: the process is marked "needs action" and waits
for a person.

### 5.7 Who a step acts as

Every step runs as the person who started the process. The process stores who they are, never a
token, and the kernel re-checks the permission at the start of every step under K-63's bound (a
revoked role takes effect within five minutes). A revoked role refuses the step and the process
takes its failure path. An approval step runs as the approver. Processes the system starts
(schedules, events) run as the app. Compensations run as the app on the person's behalf, both in the
log: cleaning up must not be stopped by a revoked role. This replaces one-model §7.6's lean ("it
runs as the app").

### 5.8 Generated and written code, versions, telemetry

| Kind | The model states | The build AI writes | The kernel runs it as |
|---|---|---|---|
| Plain read or simple write | The operation and its URI | The whole body | One segment; a write in one transaction |
| Read needing other apps | Dependencies on other contracts, requirement text | The whole logic | Each call an invisible step; nothing saved; 200 |
| Write needing an outside answer | A process diagram, or only the dependencies | The step bodies, in a generated skeleton | Visible steps, each committed |

Without a diagram the generator lays out a default skeleton (*before*, *call*, *after*). At release,
the steps' URIs, order and kinds are compared with the model, and a difference refuses the release.

A process belongs to the version of its definition it started in, not to the release. A release
that does not bump the definition lets running processes continue on the new code at their next
step. A release that bumps it lets old processes finish on the latest code of the old version. A
structural change without a bump is refused. Within a major, schema changes are additive (K-65).

The kernel emits a data point at every boundary it sees (operation, step, call) carrying the model
URI, revision, release, timing, target, attempts and outcome, never content. A call to a contract
the model does not declare is refused, so every call matches an edge in the model. The kernel and
the app's code share an isolate, so anything that must be exact (billing counts) is measured outside
it, in the supervisor or the broker.

The step journal lives in the kernel, in the scope's own SQLite, committed with the step's data.
This replaces one-model §7.6's default candidate, Cloudflare Workflows: a Workflows step does not
commit with the outbox, and the pure host has no Workflows. §7.6's lean on *when* stands: the engine
is built at the first flow that waits on a person or a time across two apps. No such consumer exists
today; K-62's attempt still meets #3289.

## 6. Track B: scopes become facets

### 6.1 The requirement

The code that handles a tenant's data runs isolated from other tenants. Not a script per tenant:
that would mean an upload per tenant at every release, and a release is uploaded once (K-65).

### 6.2 The shape

D-70's shape, applied to scopes and brokers. Each scope stays one Durable Object, split in two
layers:

- **The supervisor** is the only class the script executes. Platform code: it receives every call,
  checks the envelope, holds the alarm and the WebSockets, and hands the facet only what it needs.
- **The facet** holds the kernel, the app's modules and the scope's data. Its code travels inert in
  the script (Text and Data modules) and is loaded through the Worker Loader into an isolate the
  platform names. It has its own SQLite, which the supervisor cannot read, with the synchronous
  transactions the kernel relies on, so the kernel moves in unchanged. It is loaded with
  `globalOutbound` pointed at the gate (§8.1) and an empty env: no bindings, only references the
  supervisor passes with the call.

Worker Loader alone is not enough: it gives an isolate and no storage, so the kernel would reach its
data through async calls. Facets are the one combination of an own isolate and own transactional
storage.

### 6.3 The isolate id decides the isolation

The no-network spike proposed an id per release. Then scopes of different tenants share an isolate
exactly as today, which protects nothing between tenants. This RFC picks an id per
(release, tenant, app): two tenants never share. D-70 showed the id is what separates isolates in one
object, and that two objects with one id reached two isolates in every run, so the per-tenant id is
the floor, not a saving.

### 6.4 A condition the rest rests on

**The script's own isolate runs no code the app wrote.** Today the app's entry (`src/worker.ts`,
its Hono routes) is the app's own code and runs in the script's isolate. Under this track it either
moves into a facet, or becomes generated platform code the app cannot edit. Without this the gate in
the same script shares memory with app code, and §8.2's injection has to leave the script entirely
(it does in this RFC regardless).

### 6.5 Spikes before building

- **The kernel in a loaded isolate.** Cold start and memory for the JavaScript kernel plus an app's
  modules (D-70 measured Python, 2–3 s cold, 3–8 ms warm, 43.6 MB heap). Whether Cloudflare bills per
  id or per isolate. Whether objects with one id ever share an isolate.
- **Alarm and data in one commit.** That an alarm set in the commit that writes the outbox row cannot
  be lost.
- **Alarms and WebSockets through the supervisor**, including **WebSocket hibernation**, which live
  reads depend on, without breaking the guarantees of transactions, the outbox and live reads.
- **The script isolate runs only platform code** (§6.4), on an app entry generated from the model.
- **The beta dependency.** Facets are in open beta. What the documentation does not say (alarms,
  facet and parent running concurrently, limits, price) has to be found by us, and the fallback kept
  runnable.

### 6.6 Moving existing data (parked)

A facet's SQLite is separate from the storage a scope has today, so every existing scope is copied
once. New scopes have nothing to move. The move is designed in detail before it is built: in stages
(test tenants, a few customers, then waves), verified per scope, pausable and abortable, with a way
back and a plan for large scopes. The starting point is K-69's lazy fleet change: register once,
perform when the scope wakes, warm up with a queue, count progress.

### 6.7 Fallback

Scopes as today: shared isolates, no closed network, D-46 and D-58 as they stand. It stays runnable
until the move is complete.

## 7. Scope types and links

K-64 lets an app declare scope types with a parent. Nothing of it is built, so changing it now is
cheap. This RFC replaces the parent link with link types the app declares, and derives which types
may talk from the model's module dependencies.

| Relation | Where | Decides |
|---|---|---|
| Module dependency | The model, between types | Which calls may exist at all |
| Link between instances | The directory, between two scopes | Which scope a call goes to, and that this pair may talk |
| Ownership | A property of the link type | Lifecycle: what happens on deletion |

A call between scopes needs a declared dependency, a link of a declared type, and the actor's right
to the operation. A scope has at most one owner, so owner links form a tree and a deletion reaches
every owned scope unambiguously. Reference links may be many-to-many and never affect lifecycle.
Ownership never crosses an app boundary. Inside an app, the door between two Durable Objects becomes
the receiving supervisor's check, which sets the actor from an envelope already verified; the
router is needed only between apps.

## 8. Track D: egress, credentials and connectors

"Egress" has meant two things. Messages leaving a scope are the broker's (§4). Traffic leaving
Cloudflare for the internet goes out through one exit: the gate, then the fence.

### 8.1 The gate and the fence

- **The gate** is the app's common exit to the internet, an entrypoint in the broker's script that
  stores nothing. Every outward call passes it: a read's direct calls, the broker's deliveries,
  connectors' traffic. A facet has no network of its own; its `fetch` is pointed at the gate, so the
  gate knows the calling tenant, app and code. It checks three levels of rule (the platform's deny
  list, the app's declared hosts, the tenant's own policy), applies rate limits and meters traffic.
  **It never touches a credential.**
- **The fence** is today's outbound worker, `apps/vertical-egress`, the dispatch namespace's
  `outbound` service (`apps/router/wrangler.jsonc`), handed `OUTBOUND_POLICY = { slug, tenant,
  hosts, … }` by the router. It keeps its check (declared hosts, no raw TCP), and becomes **the only
  place a credential is injected** (§8.2).

The gate is not part of the broker. The broker owns state (when a message is sent, how often it is
retried, who waits); the gate only decides whether a call is allowed. A read stores nothing and
retries nothing; 200 users opening a view that reads an outside service must not all pass one
Durable Object, and must not stop when the broker is down.

`fetch` is allowed from all code, to declared hosts. In a read it goes straight through the gate and
the read waits outside the queue. In a write it becomes its own step through the broker. A call never
sits in the middle of a local step, because local steps have no network. The `outbound` declaration
grows: purpose, which personal data classes the host may receive, whether a repeat is safe, and which
connection supplies the credential.

### 8.2 Credential injection in the fence

Today a first-party connector's credential never leaves the platform, because the control plane
runs it. A vertical-defined connector receives the plaintext (D-64). Under this track no app code
sees a credential, whoever wrote the connector:

```
facet: fetch(api.example) → gate (policy, limits, metering; no credential)
                          → fence (platform script): fetch the sealed credential, inject, send
```

The credential stays sealed in the platform and is opened only in the platform's own scripts: the
control plane where it is stored, and the fence where it is injected. It never enters the app's
script, so injection does not depend on §6.4.

### 8.3 Rules for injection

- **A credential is bound to its host** (and, declared, to methods and paths). It is never injected
  into a call to another declared host. Without this, code declares a second host and receives the
  credential there. This rule can be decided now.
- **One mechanism for both sources.** A connection's credential and an app secret used only in an
  auth header are both sealed, bound to a host and injected. Such a secret is declared as *injected
  for host X* instead of being bound into the worker.
- **It covers credentials sent as they are** (an API key in a header, a bearer token). Signed
  requests (HMAC, SigV4), JWT client assertions, mTLS and OAuth refresh need the platform to
  implement the scheme; otherwise the code must see the key, and such a secret stays an ordinary
  binding, declared as one. A response carrying tokens (a token endpoint's) is handled by the
  platform and never passed on.
- **Code cannot read a credential, but can use it** against the declared host within the
  connection's grants. This protects against exfiltration, not misuse. Misuse is bounded by the
  declaration, the rate limits and the audit log of every call.

### 8.4 The write-only door

An app may configure a connection from inside itself: it can set or replace a credential and never
read it back. The platform seals it, runs the probe through the fence with it, and answers only
"works" or "does not". But a credential typed into the app's own form has been seen once by the
app's code, and code an AI wrote could log it there. So:

- **By default the credential is captured where the app never sees it**: a form the platform owns,
  embedded in the app or as a hop to the dashboard, or OAuth with the platform's callback. The
  relay of `connections.md` §3.5.2 is the existing door to build on.
- The app's own form may exist, and then the declaration says the app sees the credential at capture,
  so the tenant knows what it trusts.

### 8.5 Connectors are structure, not a boundary

With injection, security no longer requires a connector. But a connector is the anti-corruption
layer between an outside API and the app's vocabulary, and gives what a declaration plus `fetch`
does not: a typed surface, the probe that asks "does this credential see the customer you meant"
(#1326), consent, OAuth, token refresh, inbound webhooks and sync, reuse across apps, and a fake in
scenario tests.

> **Security comes from injection: code never sees a credential. A connector is a structural unit,
> not a security boundary. A call without credentials to a declared host may go straight through
> `fetch`. Everything that holds a customer's credential goes through a connector.**

A connector's code runs in the facet like any app code, its traffic through the gate. D-64's
contract changes: `secret` in `ConnectionContext` goes away, or becomes optional for a connector
that needs only an injected credential.

Rate limits: a central limit is needed only where a limit is shared between tenants. Each tenant's
broker follows a service's `429` and `Retry-After`, and a limit per (tenant, host) may be declared. A
central limit is built only for keys the platform itself owns.

## 9. Monitoring and the lake

### 9.1 Who sees what

Platform telemetry carries no message content.

| Who | Sees |
|---|---|
| The platform's operators | Everything aggregated, per tenant, app, channel and step; a trace id through every hop, metadata only |
| The tenant's admin | Their tenant in full: every installed app, the trace view, dead letter with content |
| The app's developer | Aggregates across tenants using the app, without seeing which; breakdowns under five tenants hidden; one tenant's trace only under a time-bound support grant; own test tenants always |

Three sources: data points to Analytics Engine (broker and kernel, at every hop and boundary,
never content); each broker's state (queue depth, oldest message, paused receivers, dead-letter
count), reported on change, not polled; and the trace view (the model's step diagram with the run
over it, for processes and reads; failures always kept; content recording only with the tenant's
permission, time-bound, stored in the tenant's own scope).

### 9.2 The lake

The lake (Iceberg on R2) is not monitoring. It is data tier 2 (D-5), the platform's history, and
K-70 makes it the long-term home of the admin log, ops failures, usage, meter days and cost days.

- **Fed by the broker.** Today the control plane's drain ships each scope's outbox through Pipelines
  to Iceberg (#1527). When the drain stops being the delivery path, the lake becomes one subscriber of
  the broker: the broker hands every message to Pipelines as one receiver among others. Data arrives
  right after commit, and K-69 holds. The broker's own delivery events (retries, pauses, dead letter)
  and the process journal go the same way.
- **Sealed content, so erasure reaches it.** The lake holds `payload`, `authorization`, `actor` and
  `subject_id` in the platform's R2, unsealed today, so an erasure after an event drained does not
  reach its lake copy (K-37, limit 6). The payload of an event carrying personal data is sealed under
  its subject's own key on the way out, with K-37's existing mechanism (keys in the directory, a
  tombstone on erasure). Crypto-shredding then reaches the lake, and the content rule can be stated
  truthfully: the platform keeps content in the lake, only sealed, and an erasure destroys it. **This
  is buildable now, in today's drain**, and the broker inherits it.
- **Exact numbers.** Analytics Engine samples at volume: enough for trends and alarms, not for
  billing. The broker counts exactly, and the lake is where the counts are kept, in line with K-70's
  meter days. Analytics Engine for trends and alarms, the broker's count for exactness, the lake for
  history.
- **No second history store.** Iceberg is already the contract for history (D-5) and the lake is
  live. External consumers can read the Iceberg tables directly. The trace view reads the lake for
  anything older than Analytics Engine keeps.

## 10. Why not Cloudflare's own services

- **A log broker (Kafka's shape)** keeps a partitioned log and lets consumers track their own
  offsets. It has no per-message acknowledgement, retries, dead letter or request-reply pairing.
  What is needed is closer to Service Bus or RabbitMQ, where the broker owns each message. The
  partitioning is borrowed, here per (tenant, app).
- **Queues** are shared by the whole account and unordered. If tenants' data is not to mix they can
  carry only references, as #3367 proposed. #3367's contract half (AsyncAPI as a declared contract)
  stands.
- **Workflows** was one-model §7.6's default for processes. With processes in the kernel the steps
  are saved in the scope's own SQLite, committed with the data, and permissions and telemetry work
  as for every other operation (§5.8).
- **Pub/Sub and K2.** Cloudflare's Pub/Sub and its log product are not needed: delivery is the
  broker's, history is the lake's. The claims about both products' status and limits in the
  proposal this RFC grew from are **not verified** here (§13).

## 11. Proposed decision records

Numbered on merge. Each is written when its track starts, not before.

| Track | Record | Rewrites |
|---|---|---|
| A | A broker per (tenant, app) owns every message after commit; the scope hands off right after commit and retries from its alarm | K-69 (delivery is decided: the broker), the platform-request caps |
| A | Delivery is effectively once inside the platform and at least once outward, with a kernel-set `Idempotency-Key` | — |
| — | The lake's payloads are sealed per subject on the way out | K-37 limit 6 |
| B | Scope and broker code run as facets in an isolate per (release, tenant, app); the script isolate runs only platform code | D-70 (the pattern extends to scopes), D-46 and D-58 (DO egress passes the gate) |
| C | The kernel serialises per segment, not per operation; a read waits outside the queue | K-6 |
| C | A write that waits on an outside answer is a kernel process that holds the entity it addresses; steps run as the starting person, re-checked | K-62, one-model §7.6 |
| — | Scope link types replace the parent link; ownership is a property of a link type | K-64 |
| D | Credentials are injected only in the platform's outbound worker, bound to a host; apps get a write-only door | D-46, D-64 |
| D | A connector is a structural unit; everything holding a customer's credential goes through one | D-64 |
| D | A credential is bound to its declared host | D-64 (decidable now) |

## 12. What gets worse

- **More moving parts before fewer.** The broker runs beside the drain during the shadow phase, and
  scopes run in two shapes during the facet move.
- **A beta dependency at the centre.** The whole data plane rests on facets and the Worker Loader. The
  fallback is today's shape, which keeps today's gaps.
- **More loaded isolates.** One per (release, tenant, app), and per object in practice (D-70). Listed
  at $0.002 per loaded worker per day past the included 1,000 a month, active ones only; whether
  billed per id or per isolate is open.
- **A weaker serialisation contract** under Track C. Code that relied on strict per-operation
  serialisation across an outward wait no longer can; the kernel holds the line with entity holds and
  revision checks, but it is a semantic change both adapters must carry.
- **The broker as a per-(tenant, app) bottleneck** in a large tenant's import, until measured.
- **Credential injection covers the simple schemes only**; the rest needs platform implementations or
  stays visible to code.

## 13. Not verified, not measured

- The kernel's cold start and memory in a loaded isolate (only Python store drivers are measured).
- Whether Cloudflare bills a loaded worker per id or per isolate.
- Alarms, concurrency and WebSocket hibernation in facets.
- A broker's throughput under a large import.
- The status and limits of Cloudflare Pub/Sub and its log product, as stated in the source proposal.
