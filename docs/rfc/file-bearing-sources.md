---
status: proposed
layer: kernel
description: A connector shape for sources that hold files rather than records (#1578) — enumerate a tree incrementally and resumably, move bytes as streams, follow a change feed with a walk as the floor, write back only where the binding allows it. Recommends running the walk as a #1577 job run whose record lives in the scope and whose passes run where the credential is; leaves three forks to a human.
---

# RFC: file-bearing sources

**Status: proposed. Nothing here is agreed.** It answers
[#1578](https://github.com/substrat-run/substrat/issues/1578), which asks whether the connector
framework survives a second shape. It recommends; a human decides. The three decisions it asks
for are §9, and they are open: the recommendation in §5 is one answer to Q1, not the answer.

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
| Cursor state today | `put/get/listConnectorState` — opaque JSON in the directory, keyed by connection, no compare-and-set, no lease. Fortnox and Planima keep a `contentHash` there and re-read everything each pass. | No provider cursor anywhere. No change-feed or etag code in the repo. |
| Bytes off the pipe | Attachments already skip it: `buildAttachmentSurface` writes R2 first, then sends the metadata row to the DO. `getConnectorAttachments(connectionId, scopeId)` lands bytes as a connection; `ScopedConnectorConnection.openAttachment` reads them in a dispatch. | **Every hop buffers.** `ConnectorResponse` has `arrayBuffer()` and no `body`; `ConnectorRequestInit.body` is `string \| Uint8Array`; `AttachmentUploadInput.body` is a `Uint8Array`; `TenantBlobStore.get/put` are whole-buffer; the hosted `ConnectorDelegation.uploadAttachment` is one buffered multipart. There is no upload size cap anywhere, so the ceiling is the worker's memory. |
| Read-only | Only by absence: a connector with no write grants, and a doc comment saying "read-only". | Nothing refuses. |
| Freshness | `recordConnectionUse` (did the last call work) and the sweep-run row (did the pass run). | Neither says how much of a tree has been seen, how far behind its feed is, or whether the last walk finished. |
| The Graph connector | App-only Graph, a per-connection certificate, `microsoft365MailSender`. Its `sweep` is a no-op. #2101 specifies drive documents for it. | No drive, `driveItem` or `/delta` code. |

Scope stores ([scope-stores.md](scope-stores.md)) were checked as a home for a mirrored tree and
are not one: a store call works only during a request, `getConnectorScope` deliberately has no
store door (that RFC's Q6), and a kind is a service, not bytes.

## 3. Three things that break if a file source is treated as a record source

#1578 names them. Each maps to one mechanism in this RFC.

1. **The unit of work is unbounded.** A reconcile is one record; an enumeration may not finish in
   one invocation. → The walk is a job run (§5.2). Resumability is the driver's, not the
   connector's.
2. **Bytes must not ride with the metadata.** → Metadata lands through the vertical's operation;
   bytes land as attachments, as streams (§6).
3. **Freshness means something different.** → The run record *is* the freshness record (§7).

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
  /** Opaque to the platform. Committed only after the page has landed. */
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
  etag?: string;              // the provider's version token, the basis of §8's conflict rule
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

- \+ No new trust surface. It is the shape #2101 is written in.
- − It rebuilds what #1577 already built — a cursor, a lease, a run record, coalescing —
  in the directory. Connector state has no compare-and-set, so two sweeps of one connection
  need a lease added there too. That is the duplication the human's DRY rule forbids, and it
  is the second time the repo would have written a durable cursor.
- − Freshness lives in the directory, where the vertical cannot read it and the dashboard reads
  it through a different path from every other run.
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
  platform (the reasoning D-63 applies to store kinds). A
  credentialed proxy is also the largest new trust surface of the three.

**C (recommended) — the run record lives in the scope; the pass runs where the credential is.**
The walk is a job run like any other. What changes is who drives it: the control plane runs the
pass engine against the **scope's** run store, reached through the connector delegation it
already uses for `invoke` and `uploadAttachment`.

- \+ One cursor, one lease, one run record, one coalescing rule — #1577's, unchanged.
- \+ The credential stays in platform connector code. The vertical never sees it.
- \+ Freshness is a `JobRun` row in the scope, which the vertical, the dashboard and an agent
  already read through `jobRuns`.
- \+ Self-host is the same code in-process, as dispatch is (connections.md §4.2).
- − A new delegated surface: the `JobRunStore` port over the vertical's platform-gated
  `/internal/connector-*` routes.
- − The control plane relays bytes (provider → control plane → the vertical's worker → R2).
  Acceptable only once §6 streams them; buffered, it is a memory ceiling per file.

### 5.2 How C fits what exists

The driver was built for this without knowing it. `runDueJobRuns` takes a `JobRunStore`, a
`handlerFor` and an `openScope`, and the Cloudflare host already runs the pass on the
coordinator with the store as RPC — "the run store is RPC to the scope DO, and nothing else".
And the driver already steps over a run whose job it does not register, *"another
deployment's"*, without failing it. So:

1. **A run owned by a connector** is a job run whose module is the connector's (for example
   `connector:<provider>`), instance = the binding. `startJobRun` coalesces a second start onto
   the live one, so a binding has at most one walk.
2. **The vertical's own driver** (its `ScopeSweeperDO` with `runJobs`) does not register that
   job, so it steps over the run and leaves it due. Nothing new is needed for that, but §9 Q1's
   detail notes one starvation case.
3. **The control plane drives it**: a connector phase, per live binding, calls `runDueJobRuns`
   with a `JobRunStore` that delegates each port method (`startOrJoin`, `dueKeys`, `claim`,
   `begin`, `miss`, `list`, `patch`, `commitPass`, `beginStep`, `recordStep`) to the vertical,
   and a `handlerFor` that answers only for its own connector's runs. `ConnectorDelegation` gains
   that port beside `invoke`; the vertical's `/internal/connector-*` routes gain its endpoints,
   gated like the others and restricted to runs whose module is a connector the scope's
   connection grants name.
4. **A pass** is: `enumerate` from the committed cursor → land the page's metadata through the
   binding's operation (one `pass.step`) → land each new or changed file's bytes as an attachment
   (one `pass.step` per file, keyed by entry id and etag, so a retried step re-lands nothing) →
   return `{ cursor, done: false }`. `caughtUp` ends the pass early; the run stays alive and
   becomes due again at the binding's interval. A walk is never `done` while the binding lives.
5. **The budget** — how many passes per tick, how many entries per page — is exactly the number
   scheduler.md §6 declined to fix "before a single real walk has said what that budget should
   be". The fixture and then the Graph connector are what set it.

The landing operation is the vertical's, declared on the binding and granted to the connection
exactly as `bindPlanimaScope` does it, so `lint:connector-grants` and the permission diff see it.
Extracting that bind from Planima and Fortnox into one helper is part of this work, not a
side-quest: the file source would otherwise be the third copy.

## 6. Bytes as streams

The attachment surface already keeps bytes off the scope pipe. What it does not do is stream, and
for a file source that is the difference between "a 2 GB drawing set" and an out-of-memory
worker. Four seams buffer today, and each widens additively:

| Seam | Today | Proposed |
|---|---|---|
| `ConnectorResponse` | `text`, `json`, `arrayBuffer` | adds `body: ReadableStream<Uint8Array> \| null` (a Web `Response` already has it) |
| `ConnectorRequestInit.body` | `string \| Uint8Array` | also a `ReadableStream` with a declared length |
| `AttachmentUploadInput.body` | `Uint8Array` | also a `ByteStream`; `sha256` computed while streaming, the row written after the object, as today |
| `ConnectorDelegation.uploadAttachment` / `openAttachment` | one buffered multipart | the body as the request/response stream, metadata in headers |

`TenantBlobStore.put` takes a stream with a known length (R2 accepts one). Order and
compensation stay what `buildAttachmentSurface` does now: object first, row second, delete on
refusal. None of this is file-source-specific — the sealed-PDF path and mail attachments benefit
the same way — which is why it is the first PR in §10 and not part of the facet.

## 7. Freshness

#1578 asks three questions. The run record answers each without a new table:

| Question | Where it is |
|---|---|
| How much of the tree has been seen? | `counters` on the run (`entries`, `files`, `bytes`, `removed`), which `pass.count` already maintains |
| How far behind the change feed is the scope? | The time since the last pass that returned `caughtUp`, plus the `feed` that pass ran on, recorded on the run's counters or cursor envelope |
| Did the last walk finish, or was it cut off? | `feed: 'walk'` with `caughtUp` false and the pass ended by budget = cut off, resuming at the committed cursor; the run's `attempts` and `last_error` say whether it is failing rather than merely long |

Connection health stays where it is (`recordConnectionUse`): a provider that refuses the
credential is a connection problem, a walk that is behind is a run problem, and an operator
should see them as two things.

## 8. Write-back and read-only

**Read-only is refused by the platform, not by the connector.** The binding carries a mode,
`read` or `read-write`. The platform wraps the connector's `FileSource` before any code sees it,
and on a `read` binding the wrapper's type has no `write` and its runtime refuses one — so a
connector cannot forget the rule and a vertical cannot reach around it. A `read-write` binding
exists only when the registration's `FileSource` has `write` and the tenant chose it when
binding.

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

- *C* reuses #1577 whole, keeps freshness in the scope, and costs a new delegated port (the
  `JobRunStore` methods over `/internal/connector-*`) plus a control-plane phase that drives
  runs. One detail to settle with it: `dueKeys` snapshots up to `JOB_DRIVE_SCAN_MAX` keys, and
  the vertical's driver steps over connector-owned ones; a scope with many due connector runs
  could fill that snapshot and starve the vertical's own jobs. Likely answer: `dueKeys` takes the
  module set the caller can run. Small, but it is a change to the port.
- *A* costs nothing in trust surface and ships soonest, and costs a second durable cursor, a
  lease added to connector state, and a freshness record nothing else reads. It is the cheaper
  first step and the more expensive second one.
- *Recommendation:* C.

**Q2 — Where the read-only mode lives: on the binding, or on the connection row.**

- *On the binding* (recommended for v1): set when a scope is bound, which is control-plane host
  code (`bind*Scope`), not the connection relay. A tenant can bind one connection read-only into
  one scope and read-write into another — which is real: an archive scope and a working scope
  against one drive. It needs **no change** under `/internal/connections/*`.
- *On the connection row*: one switch per connection, visible on the connection's own door. It
  would change the connection store and the `/internal/connections/upsert` relay, which is an
  area that needs the owner's approval before any change. It also cannot express the
  per-scope case above.
- They are not exclusive: a connection-level ceiling intersected with a binding-level choice is
  the general form. v1 does not need the ceiling.

**Q3 — Does #2101 wait for this shape.**

- *Wait:* #2101 becomes the second `FileSource` (the fixture being the first), its delta token
  is the run's cursor, its folder fence is §4's root, and its writes go through §8's wrapper. It
  lands later and lands once.
- *Don't wait:* #2101 ships as written (delta token in connector state, its own fence, its own
  bind), and this shape is extracted from it afterwards. It lands sooner and is then rewritten,
  and the shape is decided by one implementation instead of two — the thing #1578 warns about.
- *Recommendation:* wait, and amend #2101's body to point at the accepted RFC once it is
  accepted. Not before.

## 10. Sequence, if accepted

Each a separate PR, each additive, each with its own changeset.

1. **Streams** (§6): `ConnectorResponse.body`, stream bodies on `ConnectorRequestInit`,
   `AttachmentUploadInput`, `TenantBlobStore.put` and the two attachment delegations. Proven on
   workerd with a body larger than the worker could buffer.
2. **The facet and its contract suite**: `FileSource`, `FilePage`, `FileEntry`, the platform
   wrapper (root fence, read-only, §8), a fixture provider with an optional change feed and an
   expirable feed token, and `fileSourceContractSuite` in `packages/contract-tests`. The suite
   asserts: an interrupted walk resumes at the committed cursor and loses nothing; a retried pass
   re-lands nothing; an expired feed token falls back to a walk; bytes read back with the
   recorded sha256; a path outside the root is refused before the provider is called; a `read`
   binding has no `write` by type and refuses one at run time; an `ifMatch` mismatch is a
   conflict, not an overwrite.
3. **The bind, extracted**: one helper behind `bindPlanimaScope`, `bindFortnoxScope` and the file
   source's bind, with the mode on the binding (Q2).
4. **The driver bridge** (Q1 = C): the delegated `JobRunStore`, its vertical-host endpoints, the
   control-plane phase that drives connector-owned runs, and the `dueKeys` module filter.
5. **The Graph drive source** (#2101, amended): the second implementation, verified against a
   real tenant.

## 11. Not proposed

- **No change** to `packages/control-plane-api/src/connect-state.ts`,
  `apps/dashboard/src/connect-round.ts`, `apps/social-relay`,
  `packages/control-plane-api/src/wfp.ts`, `/internal/email/*` or `/internal/connections/*`. v1
  avoids the last by putting the mode on the binding (Q2).
- No live listing. Module code cannot fetch, and no screen asks the provider "what is in the
  folder now"; the mirror is what a screen reads.
- No bidirectional merge. A conflict is reported (§8), not resolved by the platform.
- No new storage tier. Bytes are attachments in the tenant's bucket; metadata is the vertical's
  own rows. Subject erasure and export reach both by the paths they already have.
