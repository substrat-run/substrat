# The model

A vertical's **model** is one TypeScript module — `spec/model.ts` — declaring what exists:
its entities, the operations over them, and the permissions those operations check.

It is not a schema language. It is TypeScript, because the compiler is what checks the joins
between those three things — and those joins are where the defects live.

## What it declares, and what it must not

| tier | contents | written by |
|---|---|---|
| **Declared** | entities, fields, relations, operations, permissions, events, returns, [lifecycles](/concepts/lifecycle) | the model, human-approved |
| **Prose** | pricing, denial reasons, the seed cast | `spec/concept.md` |
| **Emitted** | `model.json`, the manifest's entity fragments, derived permission and event lists | code |
| **Authored** | handler bodies — the business logic | you |

The line: **the model says what exists and what is legal; prose says what to do about it.**

::: warning This page used to say the opposite
Until #844 this table put state machines under *Prose*, and this paragraph read *"if you
find yourself inventing a way to declare a state transition, the boundary has slipped."*

That was wrong in a way the codebase had already demonstrated. Six entities across four
engines and two demos carried a `status` enum, and every one of them described its
transitions a second time as hand-written guards in operation bodies — held to the enum by
nothing. One engine wrote its state *set* out twice, as two independent `z.enum` literals.
The boundary had not been holding; it had been quietly redrawn at every call site.

What the old line was protecting is still protected, and now explicitly: a lifecycle
declares **which states exist and which operation moves between them**, and it cannot
declare an action, a condition, an effect or a timer. See
[Lifecycles](/concepts/lifecycle#what-a-lifecycle-cannot-say).
:::

There is deliberately **no tenancy annotation**, and there never will be. An operation runs
inside a scope that already *is* a tenant, and `ctx.sql` cannot reach another — so there is
nothing to forget. The best thing a modelling vocabulary can do with a rule is not need to
express it.

## Entities

```ts
import { defineEntities, emitModel } from '@substrat-run/contracts';
import { z } from 'zod';

export const entities = defineEntities({
  customer: {
    table: 'acme_customers',
    fields: z.object({
      id: z.string(),
      number: z.string(),
      name: z.string(),
      created_at: z.string(),
    }),
    key: ['number'],
    erasable: ['name'],
  },
  site: {
    table: 'acme_sites',
    fields: z.object({ id: z.string(), customer_id: z.string(), address: z.string() }),
    parents: ['customer'],
  },
});
```

Field names mirror the SQL columns exactly, snake_case included. A prettier domain naming
here would be a second description of the same rows, and two descriptions are how they come
to disagree.

**Not every table is keyed by `id`.** `primaryKey` defaults to `['id']` and is declared where
the identity is something else — most often the `vertical_` side table the
[composition rules](/guide/agent-rules) prescribe for extra data on an engine's entity:

```ts
// Its identity IS the work order's. An `id` of its own would permit two side rows
// for one work order, which is the thing a primary key exists to prevent.
workorderExt: {
  table: 'vertical_workorder_ext',
  fields: z.object({ workorder_id: z.string(), route_note: z.string().nullable() }),
  primaryKey: ['workorder_id'],
},
// And the ordinary value-keyed shape: one budget per customer per month.
budget: {
  table: 'vertical_time_budget',
  fields: z.object({ customer_id: z.string(), year: z.number(), month: z.number(), hours: z.string() }),
  primaryKey: ['customer_id', 'year', 'month'],
},
```

It stays separate from `key` because SQL's own distinction is the useful one: `primaryKey` is
identity, `key` is an additional uniqueness rule, and a table legitimately has both. An
entity with neither an `id` field nor a `primaryKey` is refused rather than emitted keyless.

An entity is still something the platform can *point at* — attachments hang off one,
[grants](/concepts/permissions) narrow to one, `ctx.link` joins two, an event is about one —
and all of that needs **one** id. So a composite key makes an entity un-pointable, and the
compiler enforces it: `parents`, `attachmentTargets`, `relations`, `emits.entity` and a
narrowed `permission.entity` accept only single-column-keyed entities.

```ts
attachmentTargets: [{ entityType: 'budget', readPermission: 'x:read' }],
//                               ~~~~~~~~
// Type '"budget"' is not assignable to type '"customer" | "ext"'.
```

A composite-keyed table is still a full model member — migrations, a row type, a place in
`model.json`. It is simply not something a grant can narrow to. Note that `ext` above stays
pointable: a single-column key that is not called `id` is still one id.

The rule is derived from the key rather than declared. A `pointable: true` flag would be a
second description of what `primaryKey` already says, and two descriptions are how they come
to disagree.

`parents` is plural and takes an array because `entityRelations` is an **allowlist**: the
kernel accumulates permitted parent types into a set, so an entity legitimately has more
than one.

## Operations

```ts
export const PERMISSIONS = ['customer:manage', 'customer:read'] as const;

export const operations = defineOperations(entities, PERMISSIONS)({
  'acme/create-customer': {
    summary: 'Register a customer',
    permission: 'customer:manage',
    input: z.object({ number: z.string(), name: z.string() }),
    output: entities.customer.fields,
    http: { method: 'POST', path: '/customers' },
    emits: {
      entity: 'customer',
      entityIdFrom: 'id',
      type: 'acme.customer-created',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'number'],
    },
  },
});
```

`input` is a **real Zod object**, not a description of one. That is the whole reason the model
is TypeScript: a schema language would need the shape written twice, and transcription is where
argument names go wrong.

Being real is also what lets the **host** parse with it. Hand your derived schemas to the
registration and every invocation is parsed before your handler runs — over HTTP, from a test,
from a seed, from a schedule:

```ts
export const shopModule: ModuleRegistration = {
  manifest: shopManifest,
  operations: { 'shop/checkout': checkoutOp, … },
  operationInputs: operationInputsOf(shopOperations),
};
```

So a handler receives input that has already been parsed: unknown keys are gone, declared
defaults are applied, and a malformed call never reached it. You do not write `.parse()` in the
handler, and a new operation cannot forget to.

Omit `input` entirely for an operation that takes no body.

### Narrowed permissions

A bare `permission: 'customer:manage'` is a **node** check — anyone holding the key anywhere
in the scope passes. An operation about *one* record says so, and there are three ways to
say it, chosen by what the input carries:

```ts
// One entity type, id in a field — the common case.
permission: { key: 'facility:manage', entity: 'facility', idFrom: 'facilityId' },

// More than one type: the TYPE comes from a field too (#890). The admissible types
// are read off that field's own schema — z.enum(['workorder', 'protocol']) — so the
// set is stated once and cannot drift from a second list.
permission: { key: 'workorder:read', entityFrom: 'entityType', idFrom: 'entityId' },

// A whole EntityRef the caller supplies — the engine case (#896). The engine narrows
// to a noun in no registry it can see (absence checks against Meridian's employee),
// so it names the FIELD carrying the ref. A dotted path reaches one level in.
permission: { key: 'absence:read', refFrom: 'subject.ref' },
```

The three are **mutually exclusive at compile time**: `entity` and `entityFrom` cannot
appear together, and `refFrom` admits neither of them nor `idFrom` — a ref already carries
both halves, so a second opinion beside it is a type error rather than a tie-break. When
the id is genuinely not in the input (`set-item-done` takes an item and checks the *list*
it sits on), say `resolved: '<why>'` in place of `idFrom` — still not a node check, and
honest that the handler finds the entity itself. An open `z.string()` behind `entityFrom`
compiles, but the conformance kit reports the operation as undrivable rather than guessing
a type.

### Paged reads

A list operation declares `paged`, and its `output` then carries the **entry** shape — the
platform supplies the envelope. There are two halves, and which one you write depends on
whether the kernel can compose your query.

#### The kernel composes it — `over`

The normal case: the walk runs over one declared entity's table. Name the entity and the
columns a caller may choose from, and the kernel builds the `WHERE`, the `ORDER BY`, the
keyset comparison, the `LIMIT` and the matching `COUNT` — **and provisions the indexes behind
them**, which is why this lives in the kernel and not in a query helper.

```ts
'acme/list-customers': {
  summary: 'Customers, newest first',
  permission: 'customer:read',
  output: entities.customer.fields,   // the ENTRY, not an array
  paged: {
    over: {
      entity: 'customer',
      sortable: ['created_at', 'name'],   // [0] is the default; ?sort= picks
      filterable: ['status'],             // ?status=… , and an index behind it
    },
    order: 'desc',
    total: true,
  },
  http: { method: 'GET', path: '/customers' },
},
```

Your handler asks `ctx.page` for the rows and keeps the projection:

```ts
const page = ctx.page<CustomerRow>('customer', { ...input, total: true });
return mapPage(page, (c) => ({ ...c, facilities: facilitiesOf(ctx, c.id) }));
```

`mapPage` re-shapes the entries and leaves the walk alone — the cursor and the total survive
it. Note what the page also bought you: that `facilitiesOf` call now runs once per customer
**on the page**, where an unbounded list ran it once per customer in the scope.

Add the manifest fragment once, derived rather than written:

```ts
lists: listsDeclaredBy(acmeOperations, acmeEntities),
```

#### You compose it — `sortKey` {#compose-sortkey}

Some reads cannot be kernel-composed, and saying so is not a failure — it is how the
declaration stays honest. A read over a **kernel table** (`_substrat_outbox`), one whose
`WHERE` is a **correlated subquery**, and one whose visibility is a **per-row permission
walk** all fall here. Declare the entry field your cursor walks and build the query yourself:

```ts
paged: { sortKey: 'article' },
```

```ts
const limit = listLimitOf(input.limit);
const rows = input.cursor
  ? ctx.sql.query<Row>('SELECT * FROM acme_prices WHERE article > ? ORDER BY article LIMIT ?', [input.cursor, limit])
  : ctx.sql.query<Row>('SELECT * FROM acme_prices ORDER BY article LIMIT ?', [limit]);
return pageOf(rows, limit, (row) => row.article);
```

For the permission-walk case, `pageVisible` over-fetches and advances the cursor by the last
row **examined** — so rows the walk rejects still move it forward. Its pages may come back
short, and a short page does **not** end the walk: only the absence of a `Link` header does.

For the third case — a list the handler has **already folded in memory**, because the read
is a projection, a correlated subquery or a join the kernel cannot compose —
`pageOverFold(rows, input, key)` cuts the page off the folded result and hands back the
same `Page<Entry>`. It does not make the read bounded at the database; it bounds what
crosses the seam and gives the caller a cursor, which is what lets a screen stop asking for
the whole table. A read that grows without limit still wants `paged.over` and an index.

**The cursor key must be unique and ordered the same way the SQL is.** A keyset walk
resumes at "the row after this key", so a key that repeats makes the walk skip the rest of
the tie or return it twice. `created_at` is the trap: it comes from `ctx.now()`, which is
stable for the whole invocation, so every row written by one operation carries the identical
instant. Where the ordering column is not unique, make the cursor the **pair** the
`ORDER BY` already uses and join it with `CURSOR_FIELD_SEPARATOR` — a separator chosen
because it cannot occur in an ISO instant, a ULID or a key:

```ts
paged: { sortKey: 'occurredAt' },
```

```ts
return pageOverFold(entries, input, (e) => `${e.occurredAt}${CURSOR_FIELD_SEPARATOR}${e.id}`);
```

`engines/metering` walks `(occurredAt, id)` and `(from, id)` that way. Spell the separator
through the constant, never inline at the call site: the two ends of one cursor cannot then
drift apart, and it appears in a search for "cursor".

#### What follows from the declaration

- the **handler's return type** becomes `Page<Entry>` — or `CountedPage<Entry>` with
  `total: true` — so declaring `paged` and returning a bare array does not compile;
- **`limit` / `cursor` / `order` / `sort` are supplied by the platform**, not declared per
  operation, so the default page size and the `LIST_PAGE_MAX` ceiling are true of every paged
  read. A request above the ceiling is refused, not silently capped;
- the **emitted OpenAPI** grows those parameters, an enum of your `sortable` columns, and one
  query parameter per `filterable` column;
- the **HTTP body is still the entries array** — the walk rides in `Link` and `X-Total-Count`
  headers (#829), so adopting `paged` does not break a client.

Filters are **equality only**. Ranges, `IN`, `LIKE` and boolean composition are where a
filter vocabulary turns into a query language; a read that needs more than equality is an
operation with its own name and its own arguments.

A cursor is only valid for the sort that issued it. **Follow the `Link` header** — it carries
the sort and every filter — rather than assembling `?cursor=…&sort=…` yourself.

`total` is opt-in because a keyset page cannot produce one for free: it costs a second
query per request, and it counts the **same filter** the page ran under. Say `true`
where a screen renders `1–20 of 340`.

See [What a good API looks like](/concepts/api-design#lists-are-pages-not-dumps) for why it
is keyset rather than offset. K-41 records why the kernel owns the composition — the index
behind a declared filter is the part contracts could not have built.

## What the compiler checks

Every one of these is a compile error, not a lint:

- `parents`, `primaryKey`, `key` and `erasable` name fields and entities that exist
- entity-pointing positions name a **pointable** entity — one identified by a single column
- `permission` names a **declared** key — a typo becomes a *"Did you mean"* suggestion
- an operation carries `permission` **or** `narrows: { reason }` — never both, never neither
- a narrowed permission is **one** of `{ entity, idFrom }`, `{ entityFrom, idFrom }` or
  `{ refFrom }` — `entity` beside `entityFrom`, or either beside `refFrom`, does not compile
- every `{var}` in an `http` path names a real input field
- **`entityIdFrom` names a field of that operation's `output`** — for a mutation writing a
  *child*, the event is usually about the *parent*, so the id field and the entity differ
- **`paged.sortKey` names a field of that operation's `output`** — same join, same reason: a
  cursor has to name something the entry actually carries
- **`paged.over.sortable` and `filterable` name columns of the named entity** — a typo is a
  compile error listing the columns that do exist, and the entity must be *pointable*, since
  a keyset walk needs one column to break ties on
- **a bare `z.array()` output with no `paged`** is refused when the module loads: a list read
  that answers with the whole table is unbounded by construction
- **`concurrency.over` names the entity the operation `emits` about** — a version is the ULID
  of the last event about the entity, so a guarded write that announces nothing would leave
  both writers' `If-Match` passing and both commits landing; refused at module load
- **a field-bag update declares `concurrency`** — an input with one required field naming
  the row and every other field optional over that entity's own columns is the shape that
  loses updates, and one with no `concurrency` is refused at module load, the same way a
  bare-array list output is
- `piiClass` is required, and anything other than `'none'` requires a `subjectId`, because an
  erasure has to be keyable
- a `payload` cannot carry a field the entity marks `erasable` — immutable events are the one
  place in a scope an erasure cannot reach

That last check resolves through `emits.entity`, so it is exact: a `name` marked erasable on
`customer` does not wrongly refuse an event about an `office` carrying its own `name`.

## Composing engines

An engine exports its entity registry and its published row schemas. Import them; never
retype an engine's shape. The registries today: `workorderEntities`, `protocolEntities`,
`bookingEntities`, `meteringEntities` (`metering-meter`, `metering-entry`,
`metering-period`) and `invitesEntities`.

```ts
import { protocolEntities, protocolInstanceRow } from '@substrat-run/engine-protocol';
import { workOrder, workorderEntities } from '@substrat-run/engine-workorder';

export const operations = defineOperations(entities, PERMISSIONS, [
  protocolEntities,
  workorderEntities,
])({
  'acme/open-job': {
    summary: 'Open a job and the work order it wraps',
    permission: 'customer:manage',
    input: z.object({ siteId: z.string() }),
    output: workOrder,                       // the engine's PUBLISHED type
    emits: { entity: 'workorder', /* the engine's entity */ … },
  },
});
```

Composing an engine means being gated by the engine's **keys**, not only your own —
`acme/open-job` above may check `workorder:read`, and the work order engine is what
declares that key, describes it and owns its meaning. The manifest says so with
`manifestOperations` (#889): descriptions are supplied, the key *set* is derived from what
the operations check, and a key another module owns is listed under
`checksDeclaredElsewhere` rather than restated:

```ts
export const manifest = moduleManifest.parse({
  id: '@acme/vertical', version: '0.1.0', kernelContract: '^0.0.1',
  migrations: { journalDir: './migrations', compatibleFrom: '0.1.0' },
  ...manifestOperations(operations, {
    permissions: { 'customer:manage': 'Open jobs and manage customers' },
    checksDeclaredElsewhere: { 'workorder:read': '@substrat-run/engine-workorder' },
  }),
  ...manifestEntities(entities, {}),
});
```

Both directions are errors at load: a key some operation checks that is neither described
nor listed elsewhere, and a `checksDeclaredElsewhere` entry no operation checks any more.
Without this the two options were both wrong — restate the engine's key (two modules
declaring one key, the prose free to drift) or declare a key of your own that the handler
does not check, which is how Callout's timeline came to tell a technician they could not
read what they read every day (#865).

Two things to know:

**A row is not a return.** `workOrder` is what an operation returns; `workorderRow` is what
the engine stores, and they differ — the row carries `facility_type`/`facility_id` as two
snake_case columns where the published type carries one `EntityRef` in camelCase. Return the
published one.

**Some engines are composed by event, not by call.** Check whether the engine exports
in-scope functions. `engine-invoicing` exports none — you *emit*, its consumers build the
invoice basis, and you read it back through its operations or by consuming its events. See
[Modules & the manifest](/concepts/modules).

## Binding the handlers

`OperationImpl` derives the handler map your operations require, and `satisfies` is the drift
detector:

```ts
export const operations = { … } satisfies OperationImpl<typeof model.operations, OperationContext>;
```

Change a declared return and `tsc` names the exact method whose handler no longer agrees. An
operation declared and not implemented — or implemented and not declared — is an error too.

## The manifest, derived

```ts
export const manifest = moduleManifest.parse({
  …,
  permissions: permissionsUsedBy(operations).map(/* … */),
  events: { emits: eventsEmittedBy(operations), consumes: [] },
  ...manifestEntities(entities, {
    engines: [protocolEntities],
    attachmentTargets: [{ entityType: 'customer', readPermission: 'customer:read' }],
    relations: [{ entityType: 'protocol', parentType: 'customer' }],
    searchables: [{ entityType: 'customer', fields: ['name', 'number'] }],
  }),
});
```

`entityRelations` is **derived** from each entity's `parents` — local edges are never written
twice. `relations` is only for edges involving a composed engine's entity, and both sides are
checked against local ∪ engine names.

`searchables` is derived in the other direction: you name the entity and the fields, and the
helper carries the entity's **table and id column** across from the registry, because the
kernel cannot build an index without them and you should not have to say where a customer
lives twice. A field the entity does not have is a compile error, and so is a
composite-keyed entity — a search hit is one id, and a table keyed by `(customer, year,
month)` has none to return. See [Reads & scaling](/concepts/reads#finding-a-row-by-what-someone-typed).

## From entities to tables {#emit-tables}

An entity registry already describes a schema. Writing that schema again by hand as SQL is
a *second description* of the same rows — and second descriptions drift, invisibly, until a
query returns `undefined` for a column somebody renamed on one side.

[`@substrat-run/model-emit`](/reference/model-emit) derives the second from the first:

```ts
import { emitTables } from '@substrat-run/model-emit';
import { entities } from './spec/model.js';

const sql = emitTables(entities);
// CREATE TABLE acme_customers (
//   id         TEXT PRIMARY KEY NOT NULL,
//   number     TEXT NOT NULL,
//   name       TEXT NOT NULL,
//   created_at TEXT NOT NULL,
//   UNIQUE (number)
// );
```

Three things about it are worth knowing here, because they are consequences of how the model
is declared:

- **It is stricter than what you would have written.** The primary key becomes `TEXT PRIMARY
  KEY **NOT NULL**` — in SQLite a non-INTEGER primary key does not imply `NOT NULL`, so the
  hand-written version accepts a NULL id. Every hand-written `vertical_*` table in this repo
  had that hole; the emitter cannot produce it, and it refuses a nullable key column for the
  same reason. A composite `primaryKey` emits as a table-level `PRIMARY KEY (a, b)`, in
  declaration order — that order is also the index its columns are searched by.
- **It refuses rather than guesses.** A Zod shape it cannot map to a column throws, naming the
  field. `z.boolean()` is refused outright for a *row* (SQLite stores 0/1 — declare
  `z.number()` and keep the row type honest); it stays right for an operation's *input*. A
  column that genuinely holds a document is declared as `jsonColumn('a reason')`, and a bare
  `z.unknown()` remains an error, so deliberately-opaque and not-yet-modelled stay
  distinguishable.
- **It emits a schema, not a history.** `journalColumns`, `journalUniques` and
  `journalPrimaryKeys` replay an existing migration journal
  so a test can hold your registry and your journal to each other, and `planMigration` says
  what *one* new entry would have to contain — with a **derived** version number, because
  declaring a version is declaring a fact a diff already knows. It refuses anything that would
  rewrite history or lose data.

## `model.json`

`emitModel(entities)` renders the registry to deterministic JSON, checked in and re-emitted
by `pnpm lint:model --check` — the same shape as the permission and API checkpoints, so a
changed table or a moved parent edge appears in the pull-request diff.

It is the artifact for consumers that **must not execute your code** (a hosted console
drawing your model) or that want diffability rather than validators (a breaking-change
classifier).

It is **not** the input for a code generator. `z.toJSONSchema` keeps declarative constraints
and drops programmatic ones — a `.refine()` and a `.brand()` vanish without trace — so a
generator reading the JSON would emit validators weaker than you declared. A generator reads
the TypeScript, where the Zod objects are live.

## See also

- [`@substrat-run/model-emit`](/reference/model-emit) — the DDL emitter, the journal reader,
  and the migration planner in full
- [Modules & the manifest](/concepts/modules) — what a module registers
- [Permissions](/concepts/permissions) — keys, roles and the proof walk
- [Events & audit](/concepts/events) — fat payloads, `piiClass`, and the spine
