---
status: proposed
layer: kernel
description: A connector shape for sources that hold files rather than records (#1578) — enumerate a tree incrementally and resumably, move bytes as streams, follow a change feed with a walk as the floor, write back only where the binding allows it. Recommends running the walk as a #1577 job run whose record lives in the scope and whose passes run where the credential is; leaves five forks to a human. Partly answered 2026-10-23: Microsoft 365 channel files (#2353) are file source #1, Q3 is overtaken, Q4 is keep, and Q1 with the facet waits for a second provider, a vertical needing its mirror's freshness, or a large-library first sync that cannot finish.
---

# RFC: file-bearing sources

**Status: proposed. Nothing here is agreed.** It answers
[#1578](https://github.com/substrat-run/substrat/issues/1578), which asks whether the connector
framework survives a second shape. It recommends; a human decides. The decisions it asks for
are §9, and they are open: the recommendation in §5 is one answer to Q1, not the answer.

> **Where it stands (2026-10-23).** The maintainer answered part of §9; the rest waits.
>
> - **The first implementation exists.** Microsoft 365 channel files shipped in #2353
>   (2026-10-17) on Q3's "don't wait" branch: delta token in connector state, its own fence and
>   its own bind. It is file source #1 and the reference shape
>   ([connections.md §6.3](../architecture/connections.md#63-file-bearing-sources-the-reference-shape)).
> - **Q3 is overtaken** by #2353.
> - **Q4 is decided: keep.** Unbinding stops updates and leaves the landed rows and attachments.
> - **Q1 is deferred**, and with it the `FileSource` facet and the job-run bridge (§10 steps
>   2–4). Both are extracted from two real implementations, not one. Q1 is decided when one of
>   these happens: a second file-bearing provider is committed; a vertical needs the freshness
>   of its own mirror; or the Microsoft 365 check against a large library (its QA step 7) shows
>   the current approach cannot finish a first sync.
> - **To build now, ahead of the facet:** streams (§10 step 1, §6), which are additive and remove
>   the per-file memory ceiling; and provider-neutral vertical-facing change and write schemas,
>   the Microsoft 365 vocabulary re-exported from `@substrat-run/contracts` under neutral names
>   while it has no live adopters.
> - Q2 and Q5 stay open. No decision record is written until Q1 is decided.

Written against `origin/main` at `c95e6d73a`. References are to sections and symbols, not
lines.

---

## 1. The ask

Every connector in the repo calls a provider's API and reconciles a record: Scrive reconciles a
signature request, Fortnox a ledger, Planima a maintenance plan, the Graph connector's mail a
send. #1578 names a second shape — a NAS share, a git host, an object store, a corporate drive —
where what a vertical wants is not "reconcile a dispatch" but:

- **enumerate** a tree incrementally, because the first pass is large and every later pass
  should ask only what changed;
- **stream bytes** in and out without them touching the scope pipe;
- **follow a change feed** where the provider has one, and **walk** where it does not, poll
  being the floor exactly as it is for the reconcile sweep;
- **write back** where the connection is not read-only, with the conflict question answered.

Its acceptance: declared, bound and listed like any connection; enumeration incremental and
resumable; bytes off the structured-clone pipe; a read-only connection refused *at the seam*;
contract-tested against a fixture provider.

## 2. What exists, and what it is missing

| Need | What `main` has | Gap |
|---|---|---|
| A declared capability | `ConnectorRegistration` (`apps/control-plane/src/connectors.ts`) with `inspector`, `dispatch?`, `sweep`, `callback?`, `consent?`, `mail?(env): MailSender`. Every wiring site derives from `CONNECTORS`. | No file facet. `mail?` is the precedent for adding one. |
| Credentials, health, dead letters | The connection store, `ConnectorConnection.fetch` with `settleConnectionUse`, routed dispatch as a `connector:<provider>` platform intent, `MAX_PLATFORM_REQUEST_ATTEMPTS` then `recordOpsFailure` ([connections.md](../architecture/connections.md) §3.7, §4.2). | None. #1578 says these are right and must not be duplicated; this RFC reuses all of them. |
| Landing data in a vertical | The bind pattern: `bindPlanimaScope` / `bindFortnoxScope` check `connectionGrantsInScope`, store a binding in connector state, and `syncPlanimaScope` lands pages through `getConnectorScope(connectionId, scopeId).invoke(<the vertical's operation>)`. | Written twice, once per connector. A third copy is the moment to extract it. |
| A resumable walk | The #1577 job driver (`packages/kernel/src/job-run.ts`): one live run per `(module, job, instance)`, a committed `cursor`, `counters`, a per-pass step ledger, leases (#2034). The run row lives in the **scope**. The pass engine (`runDueJobRuns`) runs on the coordinator against a `JobRunStore` port; on Cloudflare that port is RPC to the scope DO. [scheduler.md](../architecture/scheduler.md) §6 names #1578 as its expected first consumer. | Nothing bridges it to a connector. A hosted vertical's job runs in the vertical's deployment, which holds no credential; the connector runs in the control plane, which holds no run table. |
| Cursor state today | `put/get/listConnectorState` — opaque JSON in the directory, keyed by connection, no compare-and-set, no lease. Fortnox and Planima keep a `contentHash` there and re-read everything each pass; the connection inspector's activity renders it on the connection's door. | No provider cursor anywhere. No change-feed or etag code in the repo. |
| Bytes off the pipe | Attachments already skip it: `buildAttachmentSurface` writes R2 first, then sends the metadata row to the DO. `getConnectorAttachments(connectionId, scopeId)` lands bytes as a connection; `ScopedConnectorConnection.openAttachment` reads them in a dispatch. | **Every hop buffers.** `ConnectorResponse` has `arrayBuffer()` and no `body`; `ConnectorRequestInit.body` is `string \| Uint8Array`; `AttachmentUploadInput.body` is a `Uint8Array`; `TenantBlobStore.get/put` are whole-buffer; the hosted `ConnectorDelegation.uploadAttachment` is one buffered multipart, and `openAttachment` returns raw bytes with the record in a header but is buffered at both ends. `ConnectorDelegation` has no remove. There is no upload size cap anywhere, so the ceiling is the worker's memory. |
| Read-only | Only by absence: a connector with no write grants, and a doc comment saying "read-only". | Nothing refuses. |
| Freshness | `recordConnectionUse` (did the last call work) and the sweep-run row (did the pass run). A job run's row is read by `ScopeHost.jobRuns`, which no dashboard, control-plane or vertical-host surface calls today. | Neither says how much of a tree has been seen, how far behind its feed is, or whether the last walk finished. |
| The Graph connector | App-only Graph, a per-connection certificate, `microsoft365MailSender`. Its `sweep` is a no-op. #2101 specifies drive documents for it. | No drive, `driveItem` or `/delta` code. |

Scope stores ([scope-stores.md](scope-stores.md)) were checked as a home for a mirrored tree and
are not one: a store call works only during a request, `getConnectorScope` deliberately has no
store door (that RFC's Q6), and a driver is a service, not bytes.

## 3. Three things that break if a file source is treated as a record source

#1578 names them. Each maps to one mechanism in this RFC.

1. **The unit of work is unbounded.** A reconcile is one record; an enumeration may not finish in
   one invocation. → The walk is a job run (§5.2). Resumability is the driver's, not the
   connector's.
2. **Bytes must not ride with the metadata.** → Metadata lands through the vertical's operation;
   bytes land as attachments, as streams, and only when they changed (§5.4, §6).
3. **Freshness means something different.** → A platform-owned envelope on the run's cursor is
   the freshness record (§7).

## 4. The facet

A connector that holds files adds one facet to its registration, beside `mail?`:

```ts
// sketch — names are proposals
interface ConnectorRegistration {
  // …existing fields
  files?(env: ConnectorEnv): FileSource;
}

interface FileSource {
  /** One page of what changed since `cursor` (null = from the start). Never more than a page. */
  enumerate(conn: ConnectorConnection, root: FileRoot, cursor: string | null): Promise<FilePage>;
  /** The bytes of one entry, as a stream with a known length. */
  read(conn: ConnectorConnection, root: FileRoot, entry: FileEntryRef): Promise<ByteStream>;
  /** Absent on a source that cannot write. */
  write?(conn: ConnectorConnection, root: FileRoot, target: FileWrite, body: ByteStream): Promise<FileWriteOutcome>;
}

interface FilePage {
  entries: FileEntry[];
  /** The connector's own position. Opaque to the platform, which only wraps it (§7). */
  cursor: string;
  /** How this page was produced — a provider change feed, or a walk. */
  feed: 'changes' | 'walk';
  /** True when the source has nothing newer than `cursor` right now. */
  caughtUp: boolean;
}

interface FileEntry {
  id: string;                 // the provider's stable id, not the path
  path: string;               // relative to the root
  kind: 'file' | 'folder';
  size?: number;
  modifiedAt?: string;        // ISO 8601
  etag?: string;              // the provider's version token, the basis of §5.4 and §8
  removed?: true;             // a tombstone from a change feed
}

interface ByteStream { body: ReadableStream<Uint8Array>; length: number; contentType: string }

interface FileWrite {
  path: string;
  /** Explicit, never implied — #2101 already asks for exactly this. */
  onConflict: 'replace' | 'rename' | 'fail';
  /** Write only if the target is still at this version (§8). */
  ifMatch?: string;
}
```

Three properties are the point:

- **Feed or walk is the source's business, behind one cursor.** A source with a change feed
  returns `feed: 'changes'`. When the feed token expires (Graph answers `410 Gone` and asks for a
  resync), the source starts a walk and says so with `feed: 'walk'`, and the platform does not
  learn a new verb. A source with no feed only ever walks. This is poll-is-the-floor applied to a
  tree.
- **The root is a fence the platform holds.** A binding names one root. The platform's wrapper
  refuses any entry or write path that resolves outside it, before the provider is called. #2101
  asks the Graph connector to fence one channel folder inside a site-wide grant; this makes that
  fence a property of every file source rather than a rule each connector remembers.
- **`write` is optional on the type.** §8 is how a read-only binding gets a handle that does not
  have it.

## 5. Where the walk runs

This is the fork the RFC exists to surface. The walk needs a durable cursor, a lease and a run
record; it also needs the credential. On a hosted vertical those are in two different
deployments.

### 5.1 The options

**A — the control plane walks; the cursor lives in connector state.** The connector's sweep
pages through `enumerate` with a budget per connection, keeps the cursor under
`putConnectorState`, and lands pages through the extracted bind.

- \+ No new trust surface. It is the shape #2101 is written in. Every value the walk acts on is
  held where the credential is.
- \+ Freshness is in connector state, which the connection inspector already renders on the
  connection's door (Planima's activity shows its `lastSync`). No new read path for the
  dashboard.
- − It rebuilds what #1577 already built — a cursor, a lease, a run record, coalescing —
  in the directory. Connector state has no compare-and-set, so two sweeps of one connection
  need a lease added there too. That is the duplication the human's DRY rule forbids, and it
  is the second time the repo would have written a durable cursor.
- − The vertical cannot read the freshness of its own mirror without a new door.
- − The sweep has no budget or lease today (`runPlatformSweep`'s connector phase); A has to add
  both, for this one consumer.

**B — the vertical's job walks, through a credentialed egress door.** The run is an ordinary
job in the vertical's deployment; its handler calls the provider through a new
`connection.substrat.internal` hop that attaches the credential, the way `store.substrat.internal`
reaches a scope store.

- \+ Full reuse of the job driver; bytes never cross the control plane.
- − On a hosted vertical the job handler is the vertical author's code. B puts provider calls,
  spending a tenant's credential, in code the platform did not review — where a connector is
  host code, never module code (D-18's third bucket), and is registered and pinned by the
  platform (the reasoning D-63 applies to store drivers). A credentialed proxy is also the largest
  new trust surface of the three.

**C (recommended) — the run record lives in the scope; the pass runs where the credential is.**
The walk is a job run like any other. What changes is who drives it: the control plane runs the
pass engine against the **scope's** run store, reached through the connector delegation it
already uses for `invoke` and `uploadAttachment`.

- \+ One cursor, one lease, one run record, one coalescing rule — #1577's, unchanged.
- \+ The credential stays in platform connector code. The vertical never sees it.
- \+ The freshness record is in the vertical's own scope, where its host code can read it through
  `ScopeHost.jobRuns` (no screen does yet).
- − The run state the platform acts on (the run's instance, payload and cursor) is held in the
  vertical's scope, so C carries the requirements of §5.3. They are what C costs in design.
- − A new delegated surface: the `JobRunStore` port, plus a remove and a run read, over the
  vertical's platform-gated `/internal/connector-*` routes.
- − No dashboard or control-plane surface reads a job run today. The connection's door needs a
  delegated read to show freshness, where A reuses the inspector path it already has.
- − The control plane relays bytes (provider → control plane → the vertical's worker → R2).
  Acceptable only once §6 streams them; buffered, it is a memory ceiling per file.

### 5.2 How C fits what exists

The driver was built for this without knowing it. `runDueJobRuns` takes a `JobRunStore`, a
`handlerFor` and an `openScope`, and the Cloudflare host already runs the pass on the
coordinator with the store as RPC — "the run store is RPC to the scope DO, and nothing else".
And the driver already steps over a run whose job it does not register, *"another
deployment's"*, without failing it. So:

1. **A run owned by a connector** is a job run whose module is the connector's (for example
   `connector:<provider>`) and whose instance is the binding's id. `startJobRun` coalesces a
   second start onto the live one, so a binding has at most one walk.
2. **The vertical's own driver** (its `ScopeSweeperDO` with `runJobs`) does not register that
   job, so it steps over the run and leaves it due.
3. **The control plane drives only the runs it owns.** It starts from its own directory: the
   live bindings of each connection, never the runs a scope lists. `JobDueKey` today is
   `{ id, module_id, job }` and `handlerFor` sees only `module_id` and `job`, so the selection
   cannot tell one binding's run from another. C therefore requires two port changes: `dueKeys`
   (or a sibling port method) carries `instance` and takes the set of modules the caller drives,
   and `handlerFor` is passed `instance` too. The control plane's `handlerFor` then answers only
   for a `(module, job, instance)` whose instance is a live binding in its own directory for that
   scope. The module filter also answers Q1's starvation detail.
4. **The control plane reaches the run store through delegation.** `ConnectorDelegation` gains
   the port's methods (`startOrJoin`, `dueKeys`, `claim`, `begin`, `miss`, `list`, `patch`,
   `commitPass`, `beginStep`, `recordStep`); the vertical's `/internal/connector-*` routes gain
   their endpoints, gated like the others.
5. **A connector-owned run lands only as the connection.** `pass.scope()` opens the system door
   as `system:<module_id>` today. For a connector-owned run the platform's `openScope` is
   `getConnectorScope(connectionId, scopeId)` — the connection's grants, the permission diff's
   view of it — and the system door is refused for that module.
6. **A pass** is: verify the cursor envelope (§5.3) → `enumerate` from it → land the page's
   metadata through the binding's operation (one `pass.step`) → land each new or changed file's
   bytes (§5.4, one `pass.step` per file) → return the new sealed envelope. `caughtUp` ends the
   pass early; the run stays alive and becomes due again at the binding's interval.

   **Steps are named by the page they land.** `enumerate` is a provider call outside the step
   ledger, and #1577's determinism rule binds a step's name to the payload and to earlier
   results. A pass retried after a kill or a takeover enumerates again from the same committed
   cursor and, on a change feed, may get a different page. If the landing step had a fixed name,
   the retry would reuse the first attempt's memoised `land` answer for a page it did not get,
   and commit a cursor past entries it never landed. So the metadata step is named by a digest of
   the page it lands (`land:<sha256 of the canonical page>`) and each bytes step by
   `bytes:<entryId>:<etag>`. A retry that gets the same page reuses its steps; one that gets a
   different page runs new ones, and the first attempt's rows are dropped at commit.

   The alternative — `enumerate` as the pass's first ledgered step, so a retry reuses the
   recorded page — is not proposed for two reasons. The page would be provider data held in the
   scope's step ledger and read back to decide what to land and which cursor to commit, which is
   exactly what §5.3 says the platform does not trust. And a page memo is bounded by the step
   row a DO will store, which would cap the page size by a storage limit rather than by the
   budget.
7. **The budget** is exactly the number scheduler.md §6 declined to fix "before a single real
   walk has said what that budget should be". It is stated in round trips to the vertical's
   deployment, because each port method is one: per pass, `claim`, `begin` and `commitPass`
   plus one landing invoke per page; per changed file, `beginStep`, `recordStep`, the upload and
   the `landed` invoke (§5.4), and a remove when it replaces bytes. Those, plus the provider's
   calls, are what the control plane's per-invocation subrequest and duration limits bound. The
   fixture and then the Graph connector are what set the numbers.

The landing operations are the vertical's, declared on the binding and granted to the connection
exactly as `bindPlanimaScope` does it, so `lint:connector-grants` and the permission diff see
them. Extracting that bind from Planima and Fortnox into one helper is part of this work, not a
side-quest: the file source would otherwise be the third copy.

### 5.3 What C requires of the platform

Under C the platform acts with a tenant's credential on state that is stored in the vertical's
scope. These are requirements of option C, not refinements of it:

- **The platform does not trust run state held in the scope.** It treats every value read
  through the delegated run store — instance, payload, cursor, counters — as input to be
  checked, never as configuration.
- **The binding is resolved from the control plane's own directory.** The connection, root,
  mode, landing operations and caps come from the binding record the control plane wrote at
  bind time, looked up by the run's instance. The run's payload carries nothing the platform
  relies on.
- **The cursor is sealed by the platform.** What the platform commits as the run's `cursor` is
  the §7 envelope, authenticated with a control-plane key and bound to the connection, the
  binding and the root. A pass whose envelope does not verify does not call the provider; the
  run fails with that reason, and a restart (§5.5) begins from a cursor the platform issued. A
  cursor can only continue a walk the platform itself started.

### 5.4 Landing, and why a re-walk does not re-land bytes

The step ledger is dropped when a pass commits (`JobRunStore.commitPass`), so step memoisation
only protects a pass that failed before committing. A change feed that expires into a walk, a
failed run started again, or a re-bind all present every entry again. What makes those cheap is
a comparison before the transfer, not the ledger:

- **The landing operation upserts by provider entry id** and returns, per entry, the
  `EntityRef` the vertical holds it as, and the attachment id and etag of the bytes the vertical
  currently has (null if none). A re-presented entry whose etag matches lands no bytes.
- **Bytes attach to that entity.** `AttachmentUploadInput.entity` is required, so the entity
  comes from the landing operation's output, and its type is one of the vertical's
  `attachmentTargets`, with write granted to the connection.
- **A changed etag replaces, by compare-and-set.** Upload the new bytes, then a second vertical
  operation (`landed`, declared on the binding) records `{ entryId, attachmentId, etag }` **only
  if** the entry still holds the attachment and etag `land` reported for this pass. On a match it
  makes the new attachment current and moves the old one to the binding's superseded set. On a
  mismatch it records nothing and answers `stale`, and the platform removes the attachment it
  just uploaded, which nothing references. A pass that outlived its lease while a newer pass
  landed a newer etag therefore cannot record older bytes over newer ones, and cannot remove the
  newer attachment: it only ever removes what it uploaded itself or what the vertical has
  marked superseded.
- **`stale` is followed by a fresh comparison, not the end of the step.** The compare-and-set
  stops older bytes overwriting newer ones, but a stale pass could still record its older bytes
  *first*; if `stale` simply ended the entry's step, the current pass would move its cursor past
  the change and leave the older etag current. So on `stale` the step re-reads the entry's held
  attachment and etag from the vertical — a new invoke, never the memoised `land` answer — and
  compares again. If the held etag is the one this pass enumerated, the step is done. Otherwise it
  renews its lease at a step boundary and tries the compare-and-set again, with the same upload,
  against the freshly read state. The loop ends when the compare-and-set succeeds, when the held
  etag matches, when the lease renewal is refused (the run belongs to another pass, whose commit
  this pass can no longer make, so it stops without writing), or after a small fixed number of
  tries, which fails the step and so the pass, without committing its cursor. Whenever it ends
  without recording the upload, the step removes that upload, which nothing references. Only the
  pass holding the lease can complete a retry, so the newest holder's view is the one that stays
  current.
- **Superseded attachments are removed by the control plane.** Each `land` call returns, beside
  its per-entry rows, up to a page of the binding's superseded attachments not yet removed,
  oldest first, whether or not their entries are in this page. The pass removes them (the remove
  is idempotent: an attachment already gone is not an error) and acknowledges them in its next
  `land` call, which drops them from the set. A remove that never ran is offered again by the
  next pass. That holds while the binding lives and through its end pass (§5.5), which drains the
  set; a binding that ends without an end pass — Q5's inert-rows option — leaves its remaining
  superseded attachments in the tenant's bucket, referenced by nothing.
- **The lease is sized against the cap.** One file's step — read, upload, `landed`, remove — has
  to fit between two lease renewals, which happen only at step boundaries. The job's `leaseMs`
  is derived from the binding's `maxFileBytes` (§6) over a floor transfer rate, and an entry the
  lease cannot cover is skipped and counted, as an over-cap one is. The lease keeps an overrun
  rare; the compare-and-set keeps it correct when it happens anyway.
- **A tombstone removes bytes.** `land` with a `removed` entry moves the attachment it held to
  the superseded set, and the removal above takes it from there. What happens to the vertical's
  own row is the vertical's choice inside its operation.
- **Remove needs a delegated verb.** `ConnectorDelegation` has `uploadAttachment` and
  `openAttachment` and no remove; `getConnectorAttachments(...).remove` exists on the host and
  is not delegated. C and A both need it added.

The exact operation pair is a proposal; the requirement is that bytes are compared before they
are moved, and that replacing and removing are specified rather than left to each connector.

### 5.5 The run's lifecycle

- **Bind** starts the run (`startOrJoin`, instance = binding id, cursor null).
- **A run that fails** (attempts exhausted, or a §5.3 refusal) is terminal under #1577. The
  control plane, on a later drive, finds the binding's run `failed` and starts a new one after a
  backoff. Its payload carries the failed run's last committed envelope, which the new run
  verifies before using it; if it does not verify, the new run starts from null and §5.4 keeps
  that from re-landing unchanged bytes. The vertical never restarts a connector-owned run.
- **Unbind ends the run before the binding is dropped.** Ending is a pass: the control plane
  claims the run, finds the binding marked ended in its own directory, and runs the **end pass**.
  The end pass calls the provider for nothing. It makes one final `land` call with no entries,
  which returns the binding's remaining superseded attachments, removes them, acknowledges them,
  repeats until the set is empty, and returns `done`. Unbinding is the bind helper's (§10 step
  3), control-plane host code, so the binding record can keep an ended marker until that pass
  has committed.
- **Every door the end pass uses requires a live connection.** `getConnectorScope` and
  `getConnectorAttachments` refuse a revoked connection, and the delegated run store would sit
  behind the same gate. So the end pass has to run *before* the connection is revoked: the
  ordering is end-before-tombstone. The other way round — a run-store and attachment door with no
  live-connection gate, usable after revoke — is not proposed; it would be a door that acts as a
  connection that no longer exists.
- **Connection revoke cannot do that without changing the revoke path.** On `main`,
  `revokeConnection` deletes every connector-state row of the connection and tombstones the
  connection in the same step, on both adapters, and the bindings are connector state. Once that
  has happened the control plane, which drives only from its own directory, never finds those
  runs again, and the doors would refuse it if it did. Ending them needs revoke to become two
  steps — mark the connection's bindings ended and stop provider calls, let the control plane run
  each end pass, then tombstone the connection and delete its state. That changes the revoke used
  by the dashboard and by the connection relay's replace path, which is an excluded area and
  needs the owner's approval. The alternative is to accept that a revoked connection's runs stay
  behind as inert rows, and its superseded attachments with them. That is Q5.
- **An orphaned run** — one whose binding the directory does not know — is ended when the
  control plane finds it under a binding it still knows. One left by a revoke is not found (Q5).
  Either way the `dueKeys` module filter (§5.2 step 3) keeps it out of the vertical's own
  driver's snapshot, so it costs a row and nothing else.
- **The mirror on unbind** — the rows and attachments already landed — is a human decision
  (Q4).

## 6. Bytes as streams

The attachment surface already keeps bytes off the scope pipe. What it does not do is stream, and
for a file source that is the difference between "a 2 GB drawing set" and an out-of-memory
worker. Four seams buffer today, and each widens additively:

| Seam | Today | Proposed |
|---|---|---|
| `ConnectorResponse` | `text`, `json`, `arrayBuffer` | adds `body: ReadableStream<Uint8Array> \| null` (a Web `Response` already has it) |
| `ConnectorRequestInit.body` | `string \| Uint8Array` | also a `ReadableStream` with a declared length |
| `AttachmentUploadInput.body` | `Uint8Array` | also a `ByteStream`; `sha256` computed while streaming, the row written after the object, as today |
| `ConnectorDelegation.uploadAttachment` | one buffered multipart (`meta` + `body`) | the body as the request stream, the metadata in headers |
| `ConnectorDelegation.openAttachment` | raw bytes with the record in a header, buffered at both ends | the same wire shape, streamed at both ends |

`TenantBlobStore.put` takes a stream with a known length (R2 accepts one). Order and
compensation stay what `buildAttachmentSurface` does now: object first, row second, delete on
refusal. None of this is file-source-specific — the sealed-PDF path and mail attachments benefit
the same way — which is why it is the first PR in §10 and not part of the facet.

**A size cap.** Once bytes stream, worker memory stops being the implicit ceiling, and nothing
bounds a single file or a binding's total. The binding declares `maxFileBytes` (and optionally a
total byte budget); an entry whose `size` is over it is not read, and is counted as skipped in
the §7 envelope so an operator can see what the mirror left out. The defaults are open (§9).

## 7. Freshness

#1578 asks three questions. The connector's cursor is opaque (§4), and the run's `counters` are
numbers that `pass.count` only adds to — they cannot hold a time or a feed kind, and over a run
that never ends they measure throughput, not coverage. So the platform owns a small envelope
around the connector's cursor, and that envelope is what the run commits as its `cursor`:

```ts
// sketch
interface FileCursorEnvelope {
  v: 1;
  inner: string;               // the connector's cursor, untouched
  feed: 'changes' | 'walk';    // what the last pass ran on
  walkStartedAt: string | null;
  walkFinishedAt: string | null;
  caughtUpAt: string | null;   // the last pass that ended caught up
  endedBy: 'caughtUp' | 'budget'; // a failed pass commits no cursor; failure is on the run row
  seen: number;                // entries presented since `walkStartedAt`; reset when a walk starts
  skipped: number;             // over the size cap (§6) or the lease (§5.4), since the same point
  mac: string;                 // §5.3
}
```

| Question | Where it is |
|---|---|
| How much of the tree has been seen? | `seen` since the current walk began, beside the count of live entries the vertical's own rows hold. `seen` counts presentations, not distinct entries: across change-feed passes one entry changed twice is counted twice, so it can overcount. The vertical's row count is the distinct measure |
| How far behind the change feed is the scope? | Now minus `caughtUpAt`, read with `feed` |
| Did the last walk finish, or was it cut off? | `walkFinishedAt` against `walkStartedAt`, and `endedBy: 'budget'` for a pass the budget stopped; the run's `attempts` and `last_error` say whether it is failing rather than merely long |

No new table: the envelope rides in the existing `cursor` column, and `counters` stay what they
are, throughput. Under C the connection's door reads it through the delegated run read; under A
the same envelope would sit in connector state, where the inspector already looks.

Connection health stays where it is (`recordConnectionUse`): a provider that refuses the
credential is a connection problem, a walk that is behind is a run problem, and an operator
should see them as two things.

## 8. Write-back and read-only

**Read-only on the typed path.** The binding carries a mode, `read` or `read-write`. The platform
wraps the connector's `FileSource` before the walk or a write uses it, and on a `read` binding
the wrapper's type has no `write` and its runtime refuses one. A `read-write` binding exists
only when the registration's `FileSource` has `write` and the tenant chose it when binding.

What that guarantees, stated exactly: nothing the vertical does, and no platform path that goes
through the wrapper, can write through a `read` binding. It does not constrain the connector's
own code: its `dispatch` and `sweep` still receive a `ConnectorConnection` whose `fetch` can send
any method, so against the connector itself the guarantee is what review of that connector
gives, as it is for every connector today. The only enforcement independent of connector code is
a read-only grant on the provider credential itself, which lives with the connection (Q2).

**Writes are event-dispatched**, the Scrive pattern: the vertical emits an event naming
attachment ids and a target; the connector's dispatch reads them (streamed, §6) and calls the
wrapped `write`. Idempotency is the dispatch ledger's, keyed on the event id, as #2101 already
specifies.

**Conflicts are answered, not assumed away.** Every write names `onConflict`. A write that
carries the `etag` the vertical last saw sends it as `ifMatch`; a provider that refuses the
precondition yields a `conflict` outcome, emitted as an event the vertical consumes, never a
silent overwrite. `replace` without `ifMatch` is the one way to say "last writer wins", and it is
said in the event, where review can read it.

## 9. Open questions for the human

Each is open. The RFC's recommendation is stated with its cost so it can be rejected cleanly.

**Q1 — Where the walk runs: C or A (§5.1).** B is argued against above and not offered.

- *C* reuses #1577 whole and costs: a new delegated port (the `JobRunStore` methods, a run read
  and a remove over `/internal/connector-*`); a control-plane phase that drives runs; the §5.3
  requirements (directory-resolved bindings, a platform-sealed cursor); and a delegated read
  before the connection's door can show freshness. It also needs the `dueKeys` change in §5.2
  step 3: today the snapshot holds up to `JOB_DRIVE_SCAN_MAX` keys and the vertical's driver
  steps over connector-owned ones, so a scope with many due connector runs could fill the
  snapshot and starve the vertical's own jobs.
- *A* costs nothing in trust surface, shows freshness through the inspector path the dashboard
  already has, and ships soonest. It costs a second durable cursor, a lease and a budget added
  to connector state and the sweep, and a freshness record the vertical cannot read.
- *Recommendation:* C, because the cursor, lease and run record are the hard part and #1577
  already proved them; but the freshness argument favours A today, and the §5.3 requirements
  are C's alone.

**Q2 — Where the read-only mode lives: on the binding, on the connection row, or on the
provider credential.**

- *On the binding* (recommended for v1): set when a scope is bound, which is control-plane host
  code (`bind*Scope`), not the connection relay. A tenant can bind one connection read-only into
  one scope and read-write into another — an archive scope and a working scope against one
  drive. It needs **no change** under `/internal/connections/*`. It holds on the typed path
  (§8), not against the connector's own code.
- *On the connection row*: one switch per connection, visible on the connection's own door. It
  would change the connection store and the `/internal/connections/upsert` relay, an area that
  needs the owner's approval before any change. It cannot express the per-scope case above and
  is no stronger than the binding against connector code.
- *On the provider credential*: the tenant grants the credential read-only scopes at the
  provider (a read-only consent scope, or a read role on the site). This is the only option the
  connector's own code cannot get past. It is per provider, it lives in the connection and its
  consent round — the excluded relay and consent code — and it means a read-write binding needs
  a second connection.
- They compose: a provider-side read-only credential is a ceiling, and the binding's mode is the
  choice under it. v1 needs only the binding.

**Q3 — Does #2101 wait for this shape.**

- *Wait:* #2101 becomes the second `FileSource` (the fixture being the first), its delta token
  is the inner cursor, its folder fence is §4's root, and its writes go through §8's wrapper. It
  lands later and lands once.
- *Don't wait:* #2101 ships as written (delta token in connector state, its own fence, its own
  bind), and this shape is extracted from it afterwards. It lands sooner and is then rewritten,
  and the shape is decided by one implementation instead of two — the thing #1578 warns about.
- *Recommendation:* wait, and amend #2101's body to point at the accepted RFC once it is
  accepted. Not before.

**Q4 — What happens to the mirror on unbind.**

- *Keep:* the rows and attachments are the vertical's data, landed through its own operations;
  unbinding stops updates and leaves them. The vertical removes them with its own operations if
  it wants to. Nothing the platform does is irreversible.
- *Remove:* the platform removes every attachment the binding landed and calls a declared
  vertical operation to drop the rows. Closer to "a mirror", and irreversible.
- *Recommendation:* keep.

**Q5 — What a connection revoke does to its runs (§5.5).**

- *Change the revoke path:* revoke becomes end-before-tombstone (§5.5). It marks the
  connection's bindings ended and stops provider calls; the control plane runs each binding's
  end pass while the connection's doors still answer; then the connection is tombstoned and its
  state deleted. Every run ends, the scope's record says why, and the superseded set is drained.
  It changes the revoke used by the dashboard and the connection relay's replace path — an
  excluded area, so it needs the owner's approval, and v1 as §11 states it does not include it.
  A revoke that must take effect at once (a leaked credential) still does: provider calls stop at
  the first step, and only the platform's own cleanup in the tenant's scope continues.
- *Accept inert rows:* revoke stays as it is. A revoked connection's runs stay `running` in
  their scopes, never claimed again. The module filter keeps them out of the vertical's driver,
  so they cost a row each; but the scope's record says "running" about a walk that has stopped,
  a later re-bind of a new connection starts a new run beside it, and the binding's remaining
  superseded attachments stay in the tenant's bucket, referenced by nothing.
- *Recommendation:* change the revoke path, with the owner's approval, because a record that
  says "running" about a stopped walk is the freshness lie §7 exists to prevent. If that approval
  is not given, inert rows are an acceptable v1, and the freshness read should show a run whose
  binding the directory does not know as stopped rather than running.

**Smaller points left open:** the size-cap defaults and whether a per-binding byte budget is
needed (§6); the exact landing-operation pair (§5.4); the budget numbers (§5.2 step 7).

## 10. Sequence, if accepted

Each a separate PR, each additive, each with its own changeset.

1. **Streams** (§6): `ConnectorResponse.body`, stream bodies on `ConnectorRequestInit`,
   `AttachmentUploadInput`, `TenantBlobStore.put` and the two attachment delegations. Proven on
   workerd with a body larger than the worker could buffer.
2. **The facet and its contract suite**: `FileSource`, `FilePage`, `FileEntry`, the platform
   wrapper (root fence, read-only, size cap), a fixture provider with an optional change feed and
   an expirable feed token, and `fileSourceContractSuite` in `packages/contract-tests`. The suite
   asserts: an interrupted walk resumes at the committed cursor and loses nothing; a re-walk
   re-lands no unchanged bytes; an expired feed token falls back to a walk; bytes read back with
   the recorded sha256; a path outside the root is refused before the provider is called; a
   `read` binding has no `write` by type and refuses one at run time; an `ifMatch` mismatch is a
   conflict, not an overwrite; an entry over the cap is skipped and counted.
3. **The bind, extracted**: one helper behind `bindPlanimaScope`, `bindFortnoxScope` and the file
   source's bind, with the mode, caps and landing operations on the binding (Q2), and the ended
   marker of §5.5.
4. **The driver bridge** (Q1 = C): the delegated `JobRunStore`, run read and remove; their
   vertical-host endpoints; the `dueKeys` instance and module filter and `instance` on
   `handlerFor`; the sealed envelope (§5.3, §7); page-digest step names (§5.2 step 6); the
   control-plane phase that drives, restarts and ends connector-owned runs, with the end pass of
   §5.5; the connection-only `openScope`.
5. **The Graph drive source** (#2101, amended): the second implementation, verified against a
   real tenant.

## 11. Not proposed

- **No change** to `packages/control-plane-api/src/connect-state.ts`,
  `apps/dashboard/src/connect-round.ts`, `apps/social-relay`,
  `packages/control-plane-api/src/wfp.ts`, `/internal/email/*` or `/internal/connections/*`. v1
  avoids the last by putting the mode on the binding (Q2). Two options this RFC presents would
  touch excluded code and need the owner's approval: the provider-credential option in Q2, and
  changing `revokeConnection` in Q5.
- No live listing. Module code cannot fetch, and no screen asks the provider "what is in the
  folder now"; the mirror is what a screen reads.
- No bidirectional merge. A conflict is reported (§8), not resolved by the platform.
- No new storage tier. Bytes are attachments in the tenant's bucket; metadata is the vertical's
  own rows. Subject erasure and export reach both by the paths they already have.
