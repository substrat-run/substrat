# What a good API looks like

Substrat is opinionated about API shape on purpose. Not because there is one true REST, but
because the alternative is that every vertical re-decides pagination, error bodies, time and
identifiers — and then a fleet of them disagrees, forever, in ways that only surface when
someone tries to write one client against two.

The goal of this page is a specific one: **a well-shaped API should be what falls out of the
defaults, not what a careful team remembers to do.** Where a convention is enforced
mechanically, that is said plainly. Where it is still a convention, that is said too.

::: info Status
Shipping today: the operation spine, boundary parsing, value types, the context clock,
lost-update safety, request idempotency, additive evolution, the generated OpenAPI
document, and the **error model** — every surface answers `application/problem+json`. The
**pagination** convention ships in `contracts` and is adopted across the platform's own
surfaces, but not yet by every engine and vertical. Nothing on this page is aspirational
without saying so.
:::

## The shape of one operation

Everything below is a variation on one idea, so it is worth seeing the whole thing once:

```ts
'callout/create-workorder': {
  summary: 'Open a work order against a facility',
  permission: 'facility:manage',
  input: z.object({
    facilityId: z.string(),
    description: z.string().min(1),
    priority: z.enum(['normal', 'urgent']).optional(),
  }),
  output: workOrder,
  http: { method: 'POST', path: '/workorders' },
}
```

That declaration is not documentation *about* the operation. It **is** the operation's
contract: the same Zod objects validate the request at runtime, type the handler at compile
time, and generate the OpenAPI document served at `/openapi.json`. There is no second place
where the truth is written down, so there is no second place for it to drift.

## The defaults

### 1. One operation, one permission, one event

Every operation's first line is its permission check:

```ts
assertAllowed(await ctx.check('facility:manage'));
```

Every mutation emits a **fat** event — one carrying enough payload that a consumer never
needs to read back across a module boundary to understand what happened. Together these give
you two things most systems retrofit badly: an authorization story that cannot be bypassed
by adding a route, and an audit trail that is a byproduct of doing the work rather than a
feature someone remembered.

How much of that is mechanism rather than discipline is worth being precise about, because
the honest answer is "most, not all":

- **Declaring the permission is a compile error to skip.** An operation carries either a
  `permission` or a `narrows` with a stated reason — never both, and never neither. An
  entity-narrowed check must say what it narrows to, and which field the entity id comes
  from; naming a field that does not exist does not compile.
- **The permission surface is re-emitted by CI.** `pnpm lint:permissions --check` renders
  each vertical's `PERMISSIONS.md` from the same objects the code uses, so a widened role
  cannot merge without appearing in the pull-request diff.
- **The handler's `assertAllowed` line is still a convention.** `tools/boundary-lint.mjs`
  enforces the data, network, spine-write and star-topology boundaries — it does not check
  that a handler calls its declared permission. That gap is closed by the declaration and by
  review, not by a linter.

### 2. Parse, don't trust

Input crosses the boundary through a Zod schema or it does not cross. Not "validate the
suspicious fields" — parse the whole input into a typed value, once, at the edge. Everything
downstream is then working with a value the type system already believes in.

### 3. Values that survive the wire

- **Money is a decimal string plus a currency**, never a float, and arithmetic goes through
  the shared helpers. See [Money](/concepts/money).
- **Identifiers are ULIDs.** Sortable by creation time, generated without coordination,
  and — usefully — they double as pagination cursors.
- **Instants are ISO 8601 with an offset**, stamped once and never re-derived.

The rule underneath all three: a value should mean the same thing after a JSON round trip as
it did before one. Floats and naive local timestamps both fail that test.

### 4. Lists are pages, not dumps

A list endpoint that returns everything is a bug with a delay on it. It passes review, it
passes tests, and then one tenant's table gets large.

The platform convention is **keyset pagination** — a cursor over the list's own sort key,
never an offset. The request carries the walk in the query string, and the response carries
it in **headers**, so the body stays the list it always was:

```http
GET /api/customers?limit=20&cursor=01J8Z3K7Q9WRT0P
```

```http
200 OK
Link: <https://api…/customers?limit=20&cursor=01J9A2M4X8QER1S>; rel="next"
X-Total-Count: 340

[ … ]
```

The `Link` is [RFC 8288](https://www.rfc-editor.org/rfc/rfc8288), the same header GitHub
serves, and it hands the client a URL to **follow** rather than one to assemble — so the
filters and the page size travel with it and cannot be dropped by accident. Its absence is
how the walk ends: no `rel="next"`, no further request. `X-Total-Count` appears only for a
list that asked for a total.

**Why headers and not a `{ entries, nextCursor }` body.** Because the body is a published
contract and the walk is not. Wrapping the body renames a live endpoint's response — `[…]`
becomes `{ "entries": […] }` — so adopting paging broke every consumer a vertical could not
see, and the rational move was to leave an unbounded list unbounded, which is the opposite
of the point. It also could not be done at all for a list whose published shape was a bare
array: a body cannot be an array and an object at once. In headers, adopting paging changes
nothing a client was already reading.

A caveat that follows from the choice: a browser client on a **different origin** cannot
read `Link` or `X-Total-Count` unless the server lists them in
`Access-Control-Expose-Headers` — and the symptom is not an error, it is a list that looks
like it has exactly one page. `PAGE_EXPOSED_HEADERS` in `@substrat-run/contracts` is the
list to expose.

**Inside the platform, a page is still a value.** `ctx`-side and `stub.invoke` callers get
`Page<T>` — `{ entries, nextCursor }` — because an operation is transport-agnostic and a
test, a seed or another operation has no HTTP response to read a header off. The handler
returns `pageOf(...)`; the HTTP mount projects it. That is also why the platform's own
control-plane API still answers with the envelope in the body: its only consumers are the
console and dashboard, versioned and deployed with it, so it has no migration problem to
solve and no unknown client to protect.

There is **one** way to page, not two. Page numbers and `offset` are not offered, and that
is a decision rather than an omission: on live data rows shift between requests, so an
offset window silently skips and duplicates rows. A cursor names a *position in the
ordering* instead of a count of rows that have scrolled past, so a row inserted mid-walk
cannot push another onto a page you already read.

The cost is honest and worth stating: keyset gives you *next*, not *jump to page 7*. A page
number is not recoverable from a cursor, and asking for one is usually a sign the screen
wants a report rather than a list.

**A total count is available, and is opt-in.** Keyset cannot produce one for free — that is
the trade for correctness under concurrent writes — so a total is a second query per
request. Business software asks for it constantly (a table of work orders with no `1–20 of
340` reads as broken), so the platform supports it rather than pretending nobody needs it.
It just declines to charge every list for it:

```ts
paged: { sortKey: 'id', total: true },
```

The handler then returns `countedPageOf(...)` instead of `pageOf(...)`, and the compiler
holds it to that; the total reaches the client as `X-Total-Count`. Two things to know about the number: it counts the **filtered** set — the
same `WHERE` the page ran under, never the table, which is the mistake that looks right
until a second list exists — and it is a snapshot, so rows written mid-walk can make page
one's total disagree with the rows eventually seen. That is inherent to counting a moving
set, not something to design around.

Two defaults worth knowing: HTTP list reads **default to a page** (20, capped at 200),
because egress is where an ever-growing table has to stop being a dump. Kernel-side reads
default to **unbounded**, because internal callers — provisioning, catalogs, sweeps — mean
"everything", and a silent cap there would let them mistake a page for the whole set.

**A search is not a list, and does not go on the list endpoint.** Once a list is paged, a
client filtering the page it received is searching the first page only — so a picker over a
large table needs a real index, not a `q` parameter bolted onto the list. Give it its own
route:

```http
GET /api/customers/search?q=ander&limit=10
```

The two reads have genuinely different contracts. A list is ordered by a declared sort key
and paged by a cursor over it; a search is ordered by *relevance*, which has no stable sort
key and therefore no honest cursor — paging a ranked result set reorders rows, and rows go
missing or double. So a search is **capped** and says so, and the caller narrows the term
rather than paging. One endpoint cannot carry both contracts, which is why every API that
has tried ends up with two anyway.

`/customers/search` does not collide with `/customers/{id}`: a static segment is registered
ahead of its parameter sibling, the same rule OpenAPI uses to resolve a concrete path before
a templated one. Declaring the operation is what gets you that ordering — a hand-written
route table has to do it by hand.

How the index itself is declared and read is in
[Reads & scaling](/concepts/reads#finding-a-row-by-what-someone-typed).

#### Declaring it

An operation declares `paged` and its `output` carries the **entry** shape; the platform
supplies the envelope, the query parameters and the handler's return type:

```ts
'acme/list-customers': {
  output: entities.customer.fields,   // the ENTRY, not an array
  paged: { sortKey: 'id', order: 'desc', total: true },
  http: { method: 'GET', path: '/customers' },
},
```

`sortKey` is compile-checked against that entry's fields, and the handler is typed to return
`Page<Entry>` — so declaring `paged` and returning a bare array does not compile. See
[The model](/concepts/model#paged-reads) for the handler side.

::: warning Declared here, adopted incrementally
The convention ships in `@substrat-run/contracts` and is used across the control plane,
dashboard and console. The `paged` declaration exists and the todo demo uses it end to end,
but most engine and vertical list operations have **not** adopted it yet — several still
return unbounded arrays. Tracked in
[#129](https://github.com/substrat-run/substrat/issues/129) and
[#811](https://github.com/substrat-run/substrat/issues/811), which also adds the declared
filter/sort vocabulary a cursor needs to stay correct under a caller-chosen sort.
:::

::: tip The one place offset survives
The console's **scope-table browser** pages with `limit`/`offset`, deliberately. It is
random access into a table for a human reading rows — "jump to 5,000" is the actual
requirement, and drift between requests is not a correctness problem there. It is a
debugging surface, not a product API, and it is the exception that has to justify itself.
:::

### 5. Failures are data

An error is part of your API surface, not an accident that happens to it. `500 Something
went wrong` is unactionable for a human and worse for an agent; `validation_failed on field
'email'` can be recovered from without a person reading a log.

The shape is [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `problem+json` with a
closed code taxonomy:

```json
{
  "type":   "https://substrat.net/errors/permission-denied",
  "title":  "Permission denied",
  "status": 403,
  "detail": "permission denied: customer:manage",
  "code":   "permission_denied",
  "permission": "customer:manage"
}
```

The codes are a small closed set — `unauthenticated`, `permission_denied`, `forbidden`,
`not_found`, `conflict`, `validation_failed`, `precondition_failed`, `rate_limited`,
`unavailable`, `internal` — because an open set is a suggestion. A module narrows one with a
`reason` slug it owns rather than inventing a code, which is the same boundary discipline
engines follow everywhere else.

One rule that is not a detail: **`internal` never carries a message.** An unrecognised throw
is by definition one nobody reviewed for what it discloses, and a multi-tenant surface is
the wrong place to find out.

**A body with no `code` is telling you something.** When a transport is relaying a status it
did not raise — a throw nobody typed, a downstream vertical's own refusal — the body is
RFC 9457's `about:blank` form: the status, the message, and no taxonomy entry. Inventing a
code there would put our vocabulary on a failure we cannot describe, and a client switching
on `code` would match it. So the absence is the honest answer, and it is also the signal
that a throw site is still untyped.

You get all of this by throwing `substratError('conflict', 'the cart is empty', { reason:
'cart_empty' })` and letting `problemResponse` render it. `code` is the platform's, `reason`
is yours.

::: info The deprecated duplicate
Every body also carries `error`, a copy of `detail`, because every SPA in this repo read
`{ error }` before the model landed. It exists for one migration window and then goes —
read `detail`.
:::

### 6. Time comes from the context

An operation should not read the wall clock. It should ask its context what time it is, so
that tests can freeze it and replay means something:

```ts
const now = ctx.now();
```

This looks like a nicety until you try to test anything with a window in it — leave
balances, metering periods, booking availability — and find that the only way to assert the
interesting case is to wait for it. A host takes a `clock`, so a scenario hands in
`frozenClock` or `manualClock` and asserts the elapsed case exactly, instead of sleeping.

It is a mechanism rather than a convention: `new Date()` and `Date.now()` in module code are
`boundary-lint` **R6** violations, the same class of ban as a `node:*` import. Code that must
read the real wall clock — a JWT whose `exp` a remote server judges — opts out in a
reviewable `boundary-lint-allow R6` block.

The value is also stable for the whole invocation, which is a second thing worth having: the
rows a write leaves and the events announcing them agree about when they happened.

### 7. Writes are safe to retry

A client that times out does not know whether the work happened. It retries, and there is a
second work order. Agents make this acute rather than novel: they retry more aggressively
than people, and they do it faster.

The client sends a token it chose. The same token on the retry returns the first response
instead of doing the work again:

```http
POST /api/workorders
Idempotency-Key: dispatch-4471
```

```http
200 OK
Idempotency-Replayed: true

{ "id": "01J8Z…", … }
```

**Nothing is declared, and that is the difference from §7b.** Every operation on an unsafe
method honours the header, because a retried write creating a second entity is a hazard on
all of them — where a lost update is a hazard on the field-bag shape alone, which is why
`concurrency` is opt-in and this is not. The client opts in by sending a key; the server
never requires one. A `GET` is already idempotent, so the header is not honoured there:
doing so would mean serving a recorded *body* for a read, which is a cache with none of a
cache's rules.

**The recording is written inside the operation's own transaction**, and three properties
fall out of that one placement rather than from mechanisms of their own:

- **A failed request is retried, not replayed.** The operation threw, the transaction rolled
  back, and the recording went with it. There is nothing to find, so the retry executes —
  correctly, because nothing happened the first time. Recording failures would have meant
  deciding which of them are permanent, and a retry after a 500 is the most ordinary thing a
  client does.
- **A replayed response describes work that actually committed.** There is no window in
  which the recording exists and the rows it describes do not.
- **A concurrent retry cannot slip past.** Invocations serialise per scope, so the second
  request takes its turn after the first has committed. Every other implementation of this
  needs an in-flight state and a "still processing" 409; this one does not.

**A key names one request.** Send the same key with a different body and it is refused with
`409 conflict`, never served the earlier response — a client that received an answer to a
question it did not ask will act on it. Two deliberate identical writes are two writes, and
a client that wanted one sends one key. A key is also scoped to the caller who sent it: two
clients will both choose `1`, and a lookup that crossed that boundary would replay one
principal's response to another.

Two limits, stated rather than discovered:

- **A replay is not a fresh authorization.** The recorded response is returned without
  running the handler, and the permission check lives inside the handler. What bounds it is
  that a caller can only ever reach responses it received itself, and that a key is
  remembered for **24 hours**. The alternative — re-running the operation so the permission
  can be re-checked — is the duplicate execution the key exists to prevent.
- **A response too large to record (over 128 KiB) refuses its replay** with `409` rather
  than executing again. Fail closed: an error the caller can act on beats doing the work
  twice, and the original did complete.

**Opting out is a line someone wrote.** An operation whose response must not be recorded —
a freshly minted secret, a one-time token — says so, and the platform then refuses the
header rather than silently storing the response or silently executing twice:

```ts
'acme/mint-token': {
  idempotency: false,   // the response is a credential; do not record it
  …
}
```

Opt-out rather than opt-in because the two read differently in a diff: a missing opt-in is
invisible, while `idempotency: false` is something a reviewer can ask about. It is the same
reasoning `narrows` applies to a permission that is deliberately not node-level — state the
exception, never the rule.

::: tip Not the event spine's idempotency
Consumers have been required-idempotent since the beginning, and the contract suite checks
it: a consumer may see an event more than once and must settle to the same state. That is
the spine re-delivering. This is a client re-sending. Different boundary, different actor,
no relationship beyond the word.
:::

### 7b. A read-modify-write says what it is writing over

Two people open the same record, both save, and the second write silently destroys the
first. There is no error, no log line, and nobody notices until the data is gone. This is
the oldest bug in multi-user software and the one hardest to see afterwards — the row looks
fine, it is just wrong.

An operation that is read-modify-write declares `concurrency`:

```ts
'callout/update-facility': {
  permission: { key: 'facility:manage', entity: 'facility', idFrom: 'facilityId' },
  input: z.object({
    facilityId: z.string(),
    name: z.string().optional(),
    address: z.string().optional(),
    accessNote: z.string().optional(),
  }),
  concurrency: { over: 'facility', idFrom: 'facilityId' },
  emits: { entity: 'facility', entityIdFrom: 'id', type: 'callout.facility-updated', … },
  http: { method: 'PATCH', path: '/facilities/{facilityId}' },
}
```

Declared once, it does three things. Every response carries the entity's version as an
`ETag`. An unsafe method compares the caller's `If-Match` against that version **inside the
operation's transaction** and refuses a stale one with `412 precondition_failed`. And the
generated browser client remembers the tag from a read and sends it on the next write to
the same entity, so an app writes no header code.

**Opt-in, not blanket.** Most declared operations are command-shaped — `todo/rename-list`
takes a name, not a whole entity it read and echoed back — and two concurrent renames do
not lose an update. A mandatory precondition there is a forced round-trip guarding nothing.

**But not left to memory.** The shape that *does* lose updates is visible in the model: one
required field naming the row, every other field optional over that entity's own columns.
An operation of that shape with no `concurrency` is refused at module load, the same way a
bare-array list output with no `paged` is.

::: tip Why the guarded operation must emit
An entity's version is the ULID of the last event about it — there is no version column
([#901](https://github.com/substrat-run/substrat/issues/901)). So a guarded write that
announces nothing is *worse* than an unguarded one: both writers pass their `If-Match`,
neither moves the version, both commit, and both get a 200 with an `ETag` asserting the
write was serialised. `concurrency.over` is therefore compile-checked against the
operation's declared `emits`.

Adopting this in Callout is what revealed that `create-facility` had never emitted at all —
so every facility it created had no version, and no conditional update against one could
ever have succeeded.
:::

Two smaller rules follow from the same reasoning:

- **The 412 does not carry the current version.** Handing it back turns the obvious client
  fix into a blind retry that overwrites whatever caused the refusal. Re-reading is what
  gives a user something to merge.
- **`ETag` must be in `Access-Control-Expose-Headers`** for a cross-origin browser client —
  `CONCURRENCY_EXPOSED_HEADERS` names it. Unexposed, the tag reads as `null`, no `If-Match`
  is ever sent, and the protection switches itself off silently in exactly the deployment
  shape where two editors are most likely.

### 8. Surfaces only grow

Once shipped, an operation's surface evolves **additively**:

- new inputs are optional, with behavior-preserving defaults;
- emitted event payload fields are frozen — renaming, removing or retyping one means a
  `schemaVersion` bump and a dual-emit deprecation window;
- permission keys are never renamed.

This is the rule that makes a fleet of independently-deployed verticals survivable. It is
also the rule that makes *deciding conventions early* matter so much: an additive-only
system is one where the cost of a wrong default compounds.

### 9. The document is generated, and CI diffs it

Every vertical serves `/openapi.json` and a rendered reference at `/api/docs`, both built
from the operation catalog — the same Zod schemas the handlers parse. The emitted document
is checked in, and CI re-emits it to fail on drift.

The reason to care: a hand-written spec is a description of what someone believed the API
did on the day they wrote it. A generated one cannot be wrong without the code being wrong.

## What "well-architected" means here

Underneath the specifics there is one idea, and it is the same one the
[three-layer rule](/concepts/modules) expresses: **prefer mechanisms to conventions.**

A convention is a thing a careful person remembers. A mechanism is a thing a careless person
cannot get wrong. Substrat's bet is that most of what people call architecture discipline is
actually the absence of mechanism — so the platform spends its complexity budget on
compile-time joins, boundary lints, checked-in artifacts that CI re-emits, and contract
tests every adapter must pass, rather than on documents describing how to behave.

Two things follow that are worth stating, because they cut against instinct:

- **A good default is one you cannot silently opt out of.** Pagination that is available is
  pagination that half the endpoints skip.
- **Two human checkpoints stay human on purpose** — a migration diff and a permission diff.
  CI going red is what makes the reading unskippable; it is not itself the approval. Some
  judgments should not be automated away, and knowing which ones is part of the design.

## The defaults at a glance

| Default | Shape | Status |
|---|---|---|
| Permission declared | `permission` or `narrows` + reason | Compile error to omit |
| Permission checked first | `assertAllowed(await ctx.check(…))` | Convention + review |
| Fat events on mutation | payload complete for consumers | Convention + review |
| Boundary parsing | Zod at the edge | Shipped |
| Money | decimal string + currency | Shipped |
| Identifiers | ULID | Shipped |
| Pagination | keyset cursor, declared with `paged`; entries in the body, the walk in `Link` / `X-Total-Count` | Declaration shipped; [#811](https://github.com/substrat-run/substrat/issues/811) to adopt everywhere |
| Lost-update safety | `concurrency` + `If-Match` / `ETag`, 412 on a stale tag | Shipped; compile error to omit on a field-bag update |
| Errors | RFC 9457 problem+json, closed codes | Shipped; `about:blank` where a status is all we have |
| Clock | `ctx.now()` | Shipped; `new Date()` in module code is a lint error |
| Idempotent writes | `Idempotency-Key`, response replayed for 24h | Shipped; honoured on every write, `idempotency: false` to opt out |
| Evolution | additive only | Convention + review |
| API document | generated, CI-diffed | Shipped |
