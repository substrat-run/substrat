---
status: building
layer: kernel
description: How one vertical receives another vertical's events in the same tenant — exports, imports, and a watermark the consumer keeps.
---

# Cross-vertical events: exports, imports, and a consumer-held watermark

**Status:** building. The contract, both adapters and the platform-sweep phase are in #1705's
first PR. The hosted transport (the control plane reaching both scopes over `/internal`, with the
router kick for prompt delivery) is in the second. The replay lever, the edge-health view, the
payload-schema classifier and the registry refusal remain. **Related:** #1706 (workload identity between
verticals, which supplies the principal and the `peers` grant used here), #1582 (a scope-wide
read after a watermark), #938 (live reads), #427 (`provides`/`requires`).

## The question

Within one scope, integration by event is the platform's strongest idea: a module emits a fat
event, another declares `consumes`, and the kernel delivers it at-least-once with a journal, a
cascade limit and `caused_by`. Nothing is wired by hand. Between two **verticals** of the same
tenant (a CRM, and a board-room app with its own audience and login, in its own scope) there
was no equivalent. A consumer had to build a pull with a hand-kept cursor, or a push with a
shared secret. Either was a weaker copy of a guarantee the kernel already had.

## The shape

```ts
// The producer (a CRM vertical): what may leave, and the key a receiver must hold.
events: {
  emits: eventsEmittedBy(ops),
  consumes: [],
  exports: eventsExportedBy(ops, { 'crm.customer-created': 'customer:read' }),
},

// The consumer (a board-room vertical): what it takes, and from which vertical.
events: {
  emits: [...],
  consumes: [{ from: 'acme/crm', type: 'crm.customer-created', schemaVersion: 1 }],
},
imports: {
  'acme/crm': {
    'crm.customer-created': async (ctx, event) => {
      const c = CustomerCreated.parse(event.payload); // its own schema, never the producer's types
      // …its own tables, its own emits. `event.source` is data, never authority.
    },
  },
},
```

An **export is a read-side declaration over the producer's own outbox.** The outbox is retained
and is already the durable record, so nothing new is written when an exported event commits.
The **consumer keeps a watermark** per producer (`_substrat_import_cursors`), in its own store.
Each pass of the platform sweep:

1. asks the consumer scope for its declared imports and its watermark (`HostAdmin.importState`);
2. resolves the producer. That is the tenant's one primary instance of the named vertical, and
   the consumer must be its own vertical's one primary instance. Forks and previews are never
   either end, and two installs are refused rather than guessed between;
3. reads the producer's outbox after the watermark **in the producer's scope, by the producer's
   code** (`HostAdmin.readExportedEvents`): `exports ∩ wants`, gated by the receiver's key;
4. hands the batch to the consumer (`ScopeHost.deliverToPeer`), which journals each event and
   runs its handlers, then moves the watermark last.

## Why a pull, and not a platform intent per event

A platform intent is a command: one shot, raised by the caller, keyed by its id. That is the
right shape for `vertical.invoke` (#1706). An export is a stream seen per consumer, and five
things a stream needs break under intents:

- **Backfill.** A consumer installed after the producer has no past intents to drain. With a
  watermark, a new edge simply starts at the beginning of the exported history.
- **Pause.** While authority is off, an intent retries to its attempt ceiling and gives up, and
  the event is lost. A held watermark waits, and the producer's outbox is the queue. This is
  #1666's rule, "restore is the lever", applied to an edge.
- **Restore.** A PITR of the consumer rewinds its watermark with its data, and the producer
  re-delivers what the restore undid. Settled intents would not.
- **Order.** A watermark delivers in outbox order per edge. A retried intent lands after later ones.
- **Cost, and erasure.** One retained intent row per event per consumer, each a fat copy of the
  event resting in the producer's spine. #1600 and #1632 were each about such a copy that
  erasure had missed.

The identity source, the resolver and the door are shared with #1706. Only the queue differs.

## What leaves, decided by the producer

- **Not exported, not read.** A type absent from the producer's registered `exports` is never
  read, whatever the request asks for. It is reported as `unexported`, not paused.
- **Authority.** The receiver's principal, `vertical:<slug>` (#1706), must hold the export's
  `readPermission` at the producer's scope. That grant is the producer's `peers` declaration,
  seated at provision and switchable off per (scope, peer). A missing key **pauses the edge**:
  nothing is read, the watermark does not move, and nothing is lost.
- **Only `piiClass: 'none'` crosses** (below).
- **The crossed fact, not the authority record.** An exported event carries its id, type,
  version, time, entity and payload. It carries nothing of the producer's `actor`,
  `authorization` or `impersonation`: a principal id means nothing to another vertical, and it
  identifies a person to anyone who can join it back.

A row that is classified, at a version the consumer does not declare, past the hop cap, or
undecodable is **withheld**. It is named without its payload, and the watermark steps past it,
because each of those facts is permanent. The consumer journals a dead letter for it, so its
operator sees what was sent and not delivered.

## What runs, decided by the consumer

Each (event, module) runs in its own transaction with its `_substrat_deliveries` row: the in-scope
consumer's shape. A redelivered event finds its row and does not run twice, a handler that
throws is dead-lettered, and the events behind it still arrive. The batch is applied under a
compare-and-set on the watermark, so an overlapping pass cannot move it backwards. Delivery
enters through #1706's door, so a handler's checks are real checks against the grants the
consumer gave the producer, and what it emits carries `caused_by` = the producer's event id.
The cause walk resolves that id through `_substrat_imports` and ends at `imported`, naming where
the chain continues. It does not end at `missing`, which would mean the record is broken.

`_substrat_imports` holds the envelope only. The payload's one copy stays in the producer's
outbox, where the producer's erasure already reaches.

**Loops.** An export's hop count is 1 + the hops of the nearest import in its cause chain, found
by a bounded walk of `caused_by` in the producer's outbox. Past 8 it is withheld as `cascade`.
The in-scope 50-round cap only defers a round to the next call, so on its own it would let two
verticals feed each other forever at sweep pace.

## PII: only `none` crosses

- `shredSubject` is per scope, and subject keys are per (scope, subject). A producer's erasure
  cannot see the consumer.
- Crypto-shredding covers the copies the platform keeps (dumps, the lake). A live copy in the
  consumer would be Tier 1 and need redaction: a cross-scope erasure that does not exist.
- Where a crossed payload actually lands is the consumer's OWN tables. That is vertical-owned
  PII, which `shredSubject` documents it does not reach, and no kernel code reads a model's
  `erasable` fields today. So "shredding reaches the consumer's copy" cannot be delivered at the
  place the data lands.

It is enforced twice. At declaration, `eventsExportedBy` refuses a type any declaring operation
classifies other than `none`. At the read, a classified row is withheld whatever its declaration
said. Subject data travels by #1706's governed call instead: permission-checked, live, and
attributable.

## Version skew

- **Runtime.** Delivery matches on (type, schemaVersion), the routable predicate #128 wanted for
  in-scope dispatch. A mismatch is withheld and dead-lettered at the consumer, naming both
  versions (K-39's loud failure). It is never handed to a handler.
- **Promote.** `exports` and `imports` sit in the permission registry, omitted when empty so no
  existing digest moves. An edge change therefore moves `digests.permission` and needs
  acknowledging, and it renders in both verticals' `PERMISSIONS.md`.
- **CI (next).** Each exported type's payload JSON Schema goes into the checked-in model artifact.
  A base-versus-head rule then refuses a removed, retyped or newly required field without a
  schemaVersion bump. That rule applies to exports only, because there the reader is another
  team's deployed code.

## Cost on a fleet-wide cron

A per-scope call is a Durable Object wake, and on the hosted path an `/internal` hop too. So the
phase never asks every scope whether it imports anything:

- **One directory read per pass** (`listScopes`, active). The producer can be any primary scope,
  so resolution needs the list, and this is the read every other phase already makes.
- **Narrowed before any scope is called.** `CrossVerticalReach.candidates` keeps only the scopes
  whose running code may import. The answer is a code fact (`consumes: [{ from }]`, carried in
  a version's permission registry as `imports`), so it is read where the code is described,
  never from the scope. The default is the host's own `registeredImports()`: a deployment that
  imports nothing makes **zero** scope calls per pass, however large the fleet. The control
  plane narrows per scope from the registry (`registryImportCandidates`). It reads the version
  each scope RUNS (`runningVersionOf`), then that version's declared `registry.imports`
  (`versionImports`), plus one `listVerticals` when a scope is on a serving script. The read is
  a directory read, never a scope wake, and deliberately unaudited: it is the platform reading
  its own code metadata, and an audited read per version per pass would grow the access log with
  fleet × tick rate. Answers are cached per isolate by (slug, version), since a pushed manifest
  never changes, so a fleet of known versions costs no read at all. Reads run at most 8 at a
  time, and a failure on one version never stops the others.
- **Dropped only when the registry says so.** A version with no manifest, no registry or no
  `imports` key imports nothing, and its scopes are not called. A consumer's `imports` reach the
  registry only from `substrat` CLI 0.34.0 on, so a version pushed by an older CLI reads this way
  until it is pushed again. A version the registry cannot answer for (a manifest that does not
  parse, a malformed row, a version it does not know) keeps its scopes as candidates, and their
  own `importState` decides. It is reported as a failed `version:<slug>@<version>` sweep-run row.
  Excluding a consumer wrongly would lose its edge with no trace. Including one wrongly costs a
  call.
- **So "zero calls with no importer" has one exception, and it is deliberate.** A scope the
  registry cannot answer for is asked once per sweep tick, whether or not it imports anything:
  a version the registry does not know, an unreadable manifest, or a scope bound to a vertical
  but to no version (`<slug>@(no version)`). It is never asked on a kick pass. The cost is one
  `importState` per such scope per tick, and each tick names them in a `version:` row, so the
  fix (re-push, or bind a version) is visible. A fleet whose every scope runs a version with a
  readable manifest that imports nothing makes zero `/internal` calls.
- **Capped.** At most `maxConsumers` candidates per pass (default 100), in a window with a random
  start (the provision reconcile's rule), so a consumer that fails every pass holds no slot
  forever. The rest are `deferred`, not dropped, because watermarks hold.

A pass is therefore bounded by `maxConsumers × (1 + 2 × sources)` scope calls: one
`importState` per consumer, then per source one `readExportedEvents` and, only when something is
new, one `deliverToPeer`. With no importer anywhere, and no version the registry cannot answer
for, it makes none.

Hosted, each of those calls is one `/internal` request to the deployment serving the scope, and one
Durable Object round trip there. The served-here check is one more round trip to the same object.
A router kick's pass costs the same for one producer: one tenant-filtered directory read, the
registry reads for that tenant's scopes (none, once cached), and the calls above for the
consumers that import from it. **Per unit of time:** at most one such pass per producer per
`CROSS_VERTICAL_KICK_WINDOW_MS` (5 s), plus one trailing pass per burst, fleet-wide, because one
Durable Object per producer holds the bit. That works out to at most 12 passes a minute for one
producer, however many responses it flags. The control plane's
`CROSS_VERTICAL_CONSUMERS_PER_PASS` sets `maxConsumers` for the sweep and the kick alike, and `0`
pauses the phase.

## The hosted transport

On the hosted path neither end of an edge lives in the control plane. Each scope's storage is in
its own vertical's dispatch deployment, and the control plane's `SCOPE` namespace is the
module-less placeholder. So the control plane runs the phase (in its scheduled sweep, and on the
router kick below) and reaches both ends over the platform-secret-gated `/internal` surface every
vertical mounts with `mountPlatformSurface`:

| Step | Route | Far end |
| --- | --- | --- |
| The consumer's imports and watermarks | `GET /internal/import-state` | `importStateLocal` |
| The producer's release after a watermark | `POST /internal/exported-events` | `exportedEventsLocal` |
| The batch, applied under the compare-and-set | `POST /internal/import-events` | `importEventsLocal` |

`hostedCrossVerticalReach` (control-plane-api) is that reach. It resolves each scope's deployment
by the ladder every delegated verb uses (serving script, then bound version, then slug). A scope
whose vertical resolves no deployment fails its edge. It never answers "imports nothing".

**An empty answer and "cannot answer" never look alike.** "Nothing new" is a real answer, so a
deployment that cannot give one must not produce it. A script that predates the routes answers
404 or its SPA shell, and `VerticalClient` turns either into a 501 that says to redeploy. A
current script over a host without the far ends answers the route's own 501. Either way the
edge reports `failed` with that reason, and its watermark holds. It never reports `idle` over a
backlog. On the consumer's side, where no producer has been named yet, the failure is an edge
to `*`: a failed `<scope>:*` sweep-run row. The same row appears when the registry says a
scope's code imports but its deployment answers that it imports nothing. That scope is not
running the version the registry names, and saying so beats every edge into it quietly
disappearing.

**Every far end proves the scope is one it serves.** A vertical's deployment is CP-less and has no
directory. An unprovisioned Durable Object answers every read with something plausible, such as a
watermark of "never read", which a pass would act on by re-delivering from the start. So each far
end first checks that the scope was provisioned in this deployment for this tenant. Provisioning
projects the vertical's role definitions under the tenant (`_substrat_roles`), and a restore
re-projects them. The check reads that without migrating, and refuses `conflict` otherwise. The
refusal is 409 on the wire, which the platform cannot mistake for the 404 of a script that
predates the route. On the shared control plane the directory's own gate (`assertServedHere`)
still refuses a hosted scope outright.

### The router kick

The sweep is the backstop, and one tick is a long time for an event another app is waiting on. An
invoke that commits an event of an exported type (its own emit, or one a consumer made in its
post-commit tail) fires `ScopeStubOptions.onExportedEvents`, and the vertical flags its response
`x-substrat-exported-events` (`EXPORTED_EVENTS_HEADER`) beside the existing
`x-substrat-platform-request`. A worker wires both with one call,
`...kickFlags((name, value) => c.header(name, value))`. The router's drain kick then carries
`{ platformRequests, exports }`, and `/internal/drain-scope` asks that producer's **kick
coalescer** to run its outgoing edges (`runCrossVerticalFrom`). Delivery then takes seconds.

- **The flag is tenant-controlled, so the bound is the platform's.** Tenant code sets the header
  and can set it on every response. The coalescer is one Durable Object per producer scope. It
  holds a start time and a dirty bit, nothing else. Passes for one producer start at least
  `CROSS_VERTICAL_KICK_WINDOW_MS` (5 s) apart. A kick while a pass runs, or inside the window,
  only marks the producer dirty, and a dirty producer gets one trailing pass at the window's end,
  by alarm. So a burst costs one pass plus one trailing pass, fleet-wide, whatever the tenant
  sends. The trailing pass is what keeps coalescing lossless: an event committed after the first
  pass read the outbox still moves within one window.
- **The coalescer holds no authority.** Its pass is the sweep's own, with the same reach and
  gates, and it re-resolves the producer as its tenant's primary instance. It is handed only
  the scope the router resolved.
- **A lost kick costs latency, never an event.** If the coalescer is unbound, unavailable, or
  its pass throws, nothing fails on the request path, and the scheduled sweep moves the edge.

- **Both flags are response headers.** The router strips every inbound `x-substrat-*` header
  before it forwards a request, so a caller can neither raise the flag nor get a vertical to echo
  one. The kick names the scope the router resolved, never one a response names.
- **A kick runs what the next sweep would run, narrowed.** It reads the producer's tenant only.
  It runs only the edges whose producer RESOLVES to the kicked scope, so a fork, a preview or a
  second install runs nothing. It asks the registry only for consumers that import from that
  vertical, and it keeps the consumer cap. The watermark's compare-and-set makes an overlapping
  kick and sweep safe.
- **What it does not cover.** Exported events committed by a peer call, a schedule or a
  cross-vertical delivery do not pass through a routed response. They wait for the sweep.

## Where it is visible

The sweep report lists every edge with its state (`delivered`, `idle`, `paused`, `unresolved`,
`stale`, `failed`) and a sentence saying why. A `vertical-events` sweep-run row is written for
every pass that moved something or could not run, in the console's Sweep runs view. A paused
edge is silent by construction, because nothing throws and nothing is lost, so this row is
where a person first sees it.

## Not yet

- A lever to move the watermark (replay from N, skip to now).
- The payload-schema classifier, and a registry refusal for a promote that drops or re-versions
  an export someone imports.
- An edge-health view beside schedule health.
