# Reads & scaling

Every scope runs a **strictly serialized executor**: one operation at a time, run to
completion ([Operations & the scope host](/concepts/scope-host)). That guarantee is what
lets module code do a read-modify-write without locks, transactions-for-concurrency, or
retry loops. It also raises the obvious question — *doesn't that mean one request at a
time?*

No. But the reason it doesn't is worth understanding, because the intuitive fix is the
wrong one.

## Serialization is per scope, not per system

The unit of serialization is the **scope**, and a scope is sized to the *consistency
domain* — one housing association, one branch, one clinic — never the whole tenant
([Tenants & scopes](/concepts/tenancy)). A thousand scopes execute a thousand operations
at once: separate execution domains, separate databases, possibly separate machines.
Only two operations *on the same scope* ever queue.

That queue is also much cheaper than it sounds. A scope's data is local to its execution
domain, so an operation is local SQLite work — microseconds to a couple of milliseconds —
not a network round-trip per query. And module code [cannot call the
network](/concepts/modules), so an operation can never hold the scope's turn while
waiting on a slow third party. The queue drains fast because operations are short.

## Why you can't just parallelize reads

The tempting fix is to let read-only operations run concurrently. It buys you almost
nothing.

A scope's execution domain is a **single isolate** — one thread. Admitting reads
concurrently would interleave them at `await` points, not run them in parallel. And SQLite
reads inside the domain are *synchronous local calls*, so there are no `await` points to
interleave at. Ten concurrent reads would still execute one after another, just with more
bookkeeping.

> **Reads get fast by getting short, not by getting concurrent.** A queue of 50 reads at
> 30µs each is invisible. At 2ms each, it isn't. Attack the duration.

## The three read paths

Reach for them in this order.

| Path | Latency | Consistency | Use for |
|---|---|---|---|
| **In-scope** (default) | µs | Serializable | Everything interactive |
| **External read model** (escape hatch) | ms | Eventually consistent | A scope whose reads outgrow its executor |
| **History tier** (Iceberg / R2 SQL) | seconds | Eventually consistent | Reporting, audit, cross-scope |

### 1. In-scope reads — the default

A read inside a scope is a local indexed query: one hop, strongly consistent, tens of
microseconds. Nearly all interactive reads belong here.

When a screen needs a shape the normalized tables don't serve cheaply — a dispatcher board
joining jobs, customers, technicians and totals — don't reach for a cache or a replica.
Keep a **projection table in the scope's own database**, maintained by an event consumer
in the same serialized turn as the write it derives from:

```ts
// The vertical's own module registration.
export const fsmModule: ModuleRegistration = {
  manifest: {
    // ...
    events: { emits: [], consumes: [{ type: 'workorder.completed', schemaVersion: 1 }] },
  },
  consumers: {
    // Fed by the engine's event. Own table, keyed by the engine's id —
    // never a column added upstream, never a read into engine tables. The
    // payload is parsed by this consumer's own schema, not the engine's types.
    'workorder.completed': (ctx, event) => {
      const { orderId } = JobCompleted.parse(event.payload);
      ctx.sql.exec(
        `UPDATE fsm_job_board SET status = ?, completed_at = ? WHERE job_id = ?`,
        ['completed', event.occurredAt, orderId],
      );
    },
  },
};
```

The read is then one indexed scan of one flat table. The consumer runs right after the write
commits, in its own transaction, inside the same serialized turn and before the call returns.
When it succeeds, neither the caller nor another operation can read a gap between the write
and its projection. A failed consumer can leave the projection behind: its transaction rolls
back while the original write stays committed, and its delivery record is where to investigate. If the scope
is interrupted inside that gap, the delivery journal hands the event over again. That is why
consumers are written to be idempotent ([Events & audit](/concepts/events#delivery-semantics)).
This is the same [side-table pattern](/concepts/modules) verticals already use to extend
engine entities, applied to read performance.

### 2. External read model — the escape hatch

If a scope's read volume genuinely outgrows its executor, the **outbox** already gives you
the way out. Event emission is transactional with the write it describes
([Events & audit](/concepts/events)), so a second drain sink can maintain a denormalized
read model in external storage (D1, KV) without any risk of a write that never reaches it.

::: warning Read-your-writes does not survive the crossing
D1's Sessions API provides sequential consistency *within D1's version space* — a
*bookmark* names a D1 version, and a replica waits to catch up before answering. But the
authoritative write lands in **the scope**, and reaches D1 only after the outbox pump runs.
At the moment the operation returns, there is no D1 bookmark that means *"after my write"*
— the two version spaces are unrelated.

So the guarantee you'd be counting on is exactly the one that breaks. Recovering it means
either mapping event id → D1 bookmark in the pump and waiting on that watermark, or
pinning a session's reads back to the scope for a window after it writes. Choose one
**before** adopting this path.
:::

Note what this implies: inside a scope you have something *stronger* than session
consistency for free — full serializability, one copy, no bookmarks to thread.
Read-your-writes isn't a problem you have; it's a problem you'd **acquire** by leaving.

### 3. History tier — not a read tier

Domain events can flow to Iceberg on R2. The history tier is intended for **reporting,
reconciliation, audit and cross-scope history**. Its tenant-scoping query gateway is
implemented, staff-only and disabled until configured; the R2 SQL transport has not yet
been verified against the real lake. See [lake reads](/reference/control-plane-api).
It is not an interactive list-view backend.

<ReadPaths />

## Finding a row by what someone typed

A picker is not a list. `listCustomers` sorted by number is the right read at forty
customers and the wrong one at forty thousand — and once a list is paged, filtering the
page in the browser searches the first page only. Declare the entity **searchable** and the
kernel builds a real index for it:

```ts
// The vertical's manifest, through `manifestEntities` — the same helper that checks
// `fields` against the entity registry.
...manifestEntities(fsmEntities, {
  searchables: [
    { entityType: 'customer', fields: ['name', 'number'] },
    // `substring` matches inside a word ("ande" → "Andersson") for a larger index.
    { entityType: 'note', fields: ['body'], tokenizer: 'substring' },
  ],
}),
```

From that declaration the kernel provisions a per-scope FTS5 index and the triggers that
maintain it, journaled like any other migration. Nothing else changes: rows are still
written with `ctx.sql`, and the index stays correct because the trigger fires no matter who
writes. That also means it is **read-after-write correct** — a customer created in one
breath is findable in the next, with no indexing lag to wait out.

The read returns ids, and you hydrate them through the query you already have:

```ts
const searchCustomers = async (ctx, { q, limit = 20 }) => {
  assertAllowed(await ctx.check(PERM.customerManage));
  const hits = ctx.search('customer', q, { limit });
  if (hits.length === 0) return { results: [], limit, capped: false };
  // One parameter for the whole list: a Durable Object refuses the 101st.
  const ids = inList(hits.map((h) => h.id)); // from '@substrat-run/contracts'
  const rows = ctx.sql.query<CustomerRow>(`SELECT * FROM fsm_customers WHERE id IN ${ids.sql}`, ids.params);
  const byId = new Map(rows.map((r) => [r.id, r]));
  // `IN (…)` loses the rank order — put it back, or the best match lands third.
  return { results: hits.map((h) => byId.get(h.id)!), limit, capped: hits.length === limit };
};
```

Three things worth knowing before you design a screen around it:

- **It is capped, not paged.** A relevance order has no stable sort key, so it has no
  honest cursor either — paging a ranked result set reorders rows, and rows go missing or
  double. Ask for the top N and tell the user to narrow the term. Deep, ordered paging is
  what a declared sort on a list read is for.
- **`ctx.search` does not check permission.** Your `assertAllowed` comes
  first, and if your entity uses narrowed grants, filter the hits you hydrate — a ranked
  top-N filtered afterwards returns *fewer* than N, so over-fetch deliberately.
- **Give it its own route.** `GET /customers/search` beside `GET /customers`, not a `q`
  parameter on the list: the two have different pagination contracts and one endpoint
  cannot carry both. The static segment is registered ahead of `/customers/{id}`
  automatically, so the two never collide.

Short terms are refused rather than answered by a scan — two characters for the default
`prefix` tokenizer, three for `substring`, which is the trigram index's own floor. Enforce
the same minimum in your operation's input schema so a caller gets a 400 that names the
field.

### Searching inside attachments

An attachment's text is indexed with no declaration. Every upload queues an extraction job,
and once it has run the file is found by a phrase from its body:

```ts
const files = await host.attachments(principal, tenantId, scopeId);
const hits = await files.search('indexation clause', { limit: 20 });
```

The kernel parses no file format itself. The parsers live in
`@substrat-run/attachment-extractors`, and whoever constructs the host passes them in:

```ts
import { defaultAttachmentExtractors } from '@substrat-run/attachment-extractors';

new CloudflareScopeHost({ /* … */, attachmentExtractors: defaultAttachmentExtractors() });
```

They read plain text, Markdown, CSV and other `text/*` files, HTML, DOCX, XLSX, PPTX and PDF.
A PDF's text layer is read; a scanned page has none and images are never OCR'd, so a scan
records `empty`, and an encrypted PDF records `failed`, saying so. A host given no extractor
for a type records it as unsupported. A host may tighten the extraction bounds — the input
ceiling, the text cap and the time budget — with its `attachmentTextBounds` option, and never
loosen them. Every attachment records how its extraction went: `pending`,
`indexed`, `empty`, `unsupported` or `failed`, with a reason.
Module code reads that record with `readAttachmentText(ctx, attachmentId)`, so a file that
yielded nothing can say so rather than look like a search with no match. The job runs off
the upload, so a file is not searchable in the same breath it lands. On a hosted vertical,
the scope sweeper drives it when its `runJobs` option is on. Files uploaded before a scope had
extraction are queued by the same driver, once per scope, a batch at a time.

Unlike `ctx.search`, this search **does** check permission. It works out which files the
caller may open before it looks at the term, using the same check `open` makes: the
attachment target's `readPermission` on the owning entity. It then matches only among
those files. A file the caller cannot open neither appears nor takes a slot. So the results
carry no count, score or snippet, and come newest first rather than by relevance: a
relevance score weighs each word by how often it occurs across every file, including the
ones the caller may not read.

A caller who holds the read permission at the scope (an editor, a member of staff) needs
one check per attachment type. A caller who holds it only on some entities (a customer in
a portal, a shared link) needs one check per owner of an indexed file. That second case is
capped at 2,000 owners. Past the cap, the search is refused with a `forbidden` error whose
`reason` is `attachment_search_too_many_owners`, whatever the term, so a screen can explain
that this kind of search is not available to that caller.

## Live updates {#live-updates}

A screen can hear that something changed and re-read through its ordinary operation.
The hosted adapter provides a WebSocket change feed; a module declares the entity types
and read permissions under `liveTargets`. The scope checks access before sending a frame,
and the frame carries no row content. Subscribing grants no new authority.

<CommunicationFlow kind="live" />

This keeps the read operation as the source of both data and permission decisions. Keep
polling and focus revalidation as a recovery path: a socket can disconnect, a feed can be
bounded, and a frame is a hint rather than a durable consumer delivery. The pure SQLite
host has no live surface; the shared route answers `501` with `x-substrat-live: poll`.

Three feed shapes serve different audiences:

| Subscription | What the scope checks | What the browser receives |
|---|---|---|
| Ordinary feed, optionally narrowed with `within: entity` | The subscriber's declared read key on each changed entity | A change hint naming the entity |
| `checkedWithin(entity, permission)` | The principal's key on the root, checked again during delivery | A bare nudge, with no entity or event type |
| `vouchedWithin(entity, { because })` | The host proves access before subscribing; the feed does not recheck that proof | A bare nudge; every read it triggers must still be authorized |

Use `checkedWithin` when there is a grant to check. A vouched socket can keep receiving
nudges after its token is revoked until it closes. Pass the session's `expiresAt` to bound
the socket's lifetime, close it on sign-out, and replace displayed content when a re-read
is refused. A permission change racing an in-flight check can allow one stale hint;
the ensuing operation checks access again.

The [mounting reference](/reference/vertical-host#mountlivereads-app-options) covers origin
checks, session expiry, narrowing and socket limits. The ticket0 inbox and conversation
views are the working example. Presence, collaborative editing and offline synchronization
are separate capabilities; a change feed does not provide them.

## Two more surfaces, and neither is a read tier

Distinct from the three read paths, a vertical's manifest can declare stores the platform
mints and injects for it:

- **A per-tenant relational store** (`tenantStores`, opened at runtime through
  `host.openTenantStore`) — one independent SQL database per tenant. It is an *own-store*
  concept, the way a vertical might keep an auth database.
- **A per-tenant blob store** (`blobStores`) — object storage behind the kernel's
  [attachment](/concepts/modules) surface, for the documents and images a scope's rows point
  at rather than contain.

Both follow the same ownership rule, and it is the interesting part: **the builder supplies
no id**. The vertical declares a *need*; the platform mints the database or bucket, holds the
cloud credential, and attaches a binding to the serving script. A vertical is handed a store —
it never names one, so it can never name someone else's.
The physical mint happens before the directory records the binding. The directory's ledger
row and its admin audit row then commit together; the minted resource cannot join that
transaction.

Neither is a read-scaling tier. Reach for them when a vertical genuinely needs storage outside
the per-scope execution domain, not to make scope reads faster. Scope reads still follow the
three paths above.

## Why not global read replicas?

Because the operational record shouldn't leave, for three reasons:

- **Residency.** Replicating operational data adds another place whose location must meet
  the product's residency requirements. A declared scope `jurisdiction` is not yet a hosted
  placement guarantee: per-jurisdiction DO IDs remain [unimplemented](/reference/adapter-cloudflare#status).
- **Consistency.** Read-your-writes does not cross the outbox, per above. Bookmarks cannot
  repair a boundary they cannot see.
- **The workload doesn't want it.** A scope maps to *one business*, whose users cluster
  around it. **Placing the execution domain well at provisioning beats replicating it.**

The honest carve-out: global replication earns its keep on **public, read-heavy,
staleness-tolerant surfaces** — customer portals, tracking links, availability views — where
the projection is a derived subset rather than the operational record, and traffic can dwarf
internal usage. That's a per-surface decision, not a platform read tier.

## When a scope really is too hot

Serialization bounds *write* throughput on a single scope, and at some point a scope can
outgrow its execution domain. The answer is never "shard the scope":

- **Split it.** A scope that's too hot is usually a consistency domain drawn too large. This
  is the same move as the [granularity rule](/concepts/tenancy) — and it's the right answer
  more often than it looks.
- **A future option is storage shape B**, where the execution domain becomes a control plane
  (hot state, locks) fronting a separate database for bulk storage and read replicas. The
  choice is per scope, and **invisible to module code**.

Shape B is not implemented by the current adapters. Splitting the consistency domain is
the available route today; moving storage behind the same `ctx.sql` contract is a future
adapter design, not a migration command a builder can run.
