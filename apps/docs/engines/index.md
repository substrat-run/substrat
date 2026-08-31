# What is an engine?

An **engine** is domain machinery shared across verticals but too domain-shaped for the
kernel: work orders, invoicing, scheduling, ticketing, protocols/checklists. Engines are
headless, versioned npm packages that register into a scope host as
[modules](/concepts/modules) — no UI framework, no HTTP server, no storage of their own
beyond the tables their migrations create inside each scope.

## The division of labor

**Engines own invariants.** State machines can't skip states. Time entries are
append-only. An exported invoice basis is immutable. Every mutation emits an event.
Every access passes a permission check.

**Verticals own everything with a user's fingerprints on it.** Vocabulary, extra states
and fields, triggers, pricing logic, screens, reports, industry content.

The design test for the boundary: **if a vertical ever needs to fork an engine, the
engine drew its line wrong.** A concrete example from the work-order engine: it has no
price list and no pricing logic — pricing differs per business, so the *vertical*
computes billable lines and hands them to `complete`. The engine enforces what must
always hold (status transitions, append-only reporting, event emission), not what any
particular business decides.

## Star topology: engines never talk to each other

No engine imports or calls a sibling — enforced by review and by design. Engines
compose through three kernel-mediated channels:

1. **Opaque refs** — an engine stores `(entityType, entityId)` without knowing what it
   is. The work-order engine binds orders to a `facility` ref it never dereferences.
2. **Events** — schema-versioned contracts on the spine. The invoicing engine consumes
   `workorder.completed` with **zero imports** from the work-order engine; it parses its
   own Zod view of the payload.
3. **Vertical-owned orchestration** — synchronous flows needing two engines are wired in
   the vertical, where the glue is visible and editable.

Why: with *N* engines talking to the kernel there are *N* contracts to keep compatible;
with engines talking to each other there are *N²*. Star topology keeps every engine
independently versionable, licensable, and replaceable.

The corollary: **if two engines need chatty synchronous communication, they are one
engine drawn wrong.** That's why "work orders + time + material" is one engine, not
three — time entries have no meaning outside their work order.

## What an engine is *not*

"Engine" is a borrowed word, and every reader arrives with a different picture of it. Four
contrasts to clear it up:

- **Not an Odoo app** (or any "app on a platform"). An Odoo app bundles the whole vertical
  slice — ORM models, logic, views, vocabulary — and extends its siblings by inheritance
  (`_inherit`, cross-app foreign keys). An engine is the inverse: headless, no UI, no
  vocabulary, owning only invariants, and forbidden from importing a sibling. What Odoo puts
  in one app, Substrat splits across an engine (the invariants) and a vertical (everything
  with a user's fingerprints on it). If you ever want to *subclass* an engine, it drew its
  line wrong.
- **Its real cousin is a [Medusa v2](https://docs.medusajs.com/learn/fundamentals/modules/isolation)
  module** — and that's no coincidence. Strict isolation, cross-module links instead of
  foreign keys, per-module migrations: Medusa converged on the same shape from e-commerce.
  Know Medusa modules and you already know engines — Substrat wraps them in nested
  multi-tenancy and runtime enforcement.
- **Not a Rails engine or a plugin.** Those are code-organization conventions; nothing at
  runtime stops a plugin from reaching into the host's tables. An engine's boundaries are
  *enforced* — another module's tables are private, reachable only through its exported
  functions and events, and the `boundary-lint` check fails the build when you cross the
  line.
- **Not a microservice.** No network hop, no separate deployment, no eventual consistency
  between engine and vertical. An engine runs in-process inside the scope, and a vertical
  composes its in-scope functions in the *same transaction* — `createWorkOrder(ctx, …)` and
  your own table write commit together or not at all. The isolation is architectural, not
  physical.
- **Not a [connector](/connectors/).** An engine owns invariants and domain state *inside* a
  scope; a connector reaches a third-party service *outside* one. An engine never calls the
  network — that is precisely a connector's job. The two are different layers, and the
  clearest tell is that an engine has tables and permissions while a connector has neither.

## Anatomy of an engine package

Every engine exports the same shape:

```ts
export const PERM = { /* parsed permission keys */ };
export const engineManifest = moduleManifest.parse({ /* self-description */ });
export const engineMigrations = [ /* ordered SQL */ ];

// In-scope functions — composable from vertical operations, same transaction.
// A by-call engine has these; a by-event engine deliberately has none (see below).
export function createWorkOrder(ctx, input) { /* ... */ }

// The full registration: manifest + migrations + default operation bindings
export const engineModule: ModuleRegistration = { /* ... */ };
```

Using an engine as-is is one line:

```ts
host.registerModule(workorderModule);
```

Wrapping it with vertical logic means writing your own operation and calling the
engine's exported in-scope functions — same transaction, same serialization domain, and
the permission check becomes your responsibility:

```ts
host.defineOperation('acme/create-order', async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.create));
  const order = createWorkOrder(ctx, mapToEngineInput(input));
  // your own tables, in the same transaction
  return order;
});
```

### Two composition modes

That sample is the **by-call** shape, and it is not every engine's. An engine is composed one
of two ways, and which one it is decides whether in-scope functions exist at all:

| | **By call** | **By event** |
|---|---|---|
| Engines | work orders, bookings, protocols, absence, invites, metering | [invoicing](/engines/invoicing/) |
| Operations are | thin — a permission check plus one exported function | the surface itself; the logic lives in them |
| A vertical | wraps the exported functions in its own transaction | *emits* a fact its consumers pick up |
| Reads results | from the function's return value | back through the engine's own operations. Its events announce that something changed and carry the change, not the whole entity, so a vertical projects them into a side table keyed by the engine's id and reads the operation when it needs the entity |
| In-scope exports | yes, that is the whole point | **none, deliberately** — the engine stays the only writer of its rows, which is what keeps an invariant like immutable-after-export safe from a half-finished caller |

The mode is a fact about an engine's exports, and the by-event one says so in its package
header, so an absent in-scope surface reads as intent rather than as an omission. If you are
integrating an engine and cannot find functions to call, check the mode before assuming they
are missing.

## Engines today

| Engine | Package | What it owns |
|---|---|---|
| [Work orders](/engines/workorder/) | `@substrat-run/engine-workorder` | the order state machine, append-only time & material reporting |
| [Bookings](/engines/booking/) | `@substrat-run/engine-booking` | allocation against capacity over an interval — no double-booking, holds and their expiry |
| [Invoicing](/engines/invoicing/) | `@substrat-run/engine-invoicing` | invoice-basis accumulation from billable events, immutability on export |
| [Protocols](/engines/protocol/) | `@substrat-run/engine-protocol` | protocols/checklists with the sign → immutable invariant, verifiable content hash |
| [Invites](/engines/invites/) | `@substrat-run/engine-invites` | single-use invitations to join an org with a role — invited → accepted; the plaintext identifier is never stored, the per-scope salted hash is |
| [Absence](/engines/absence/) | `@substrat-run/engine-absence` | the append-only absence ledger over an opaque subject — balance as a fold, approval as the only mint for bookings, per-type floors |
| [Metering](/engines/metering/) | `@substrat-run/engine-metering` | the billable-usage ledger — idempotent ingest, counters vs gauges, period close as frozen billing evidence; quantities, never prices |

All seven are **product seeds** — small deliberately, hardened as real verticals
consume them. Six were extracted from the demo verticals; metering is the one exception,
noted below.

The booking engine is the one **second invariant shape**: where a work order is a *state
machine*, a reservation is *allocation against capacity over an interval*. It is also the
clearest demonstration that the DO-per-scope choice buys something concrete — the engine
contains no locking code at all, because a scope is a single writer. The protocol engine is the extraction proof
itself: it was forced out of vertical code only when a *second* vertical (a bike shop's
per-bike condition report) needed the same sign-immutability invariant in a different
shape — and a *third*, [an HR vertical](/guide/what-is-substrat#current-status), reuses it
again for employee **onboarding checklists**, bound to an `employee` ref instead of a work
order. Same engine, three shapes; that is the reuse thesis holding.

The absence engine is the newest extraction, and the second run of the protocol engine's
proof: its *append-only, a-correction-is-a-new-entry, current-value-is-a-fold* shape was
written vertical-first inside the HR demo, and extracted only when a second consumer with
a different shape — field-crew resource planning, where the subject is a plannable
`resource` rather than an employee — forced the line. (The question of whether the
generic entries-against-a-ref core belongs in the kernel was considered and settled:
it stays engine-private until a non-absence consumer wants the raw ledger shape.)

The metering engine is the honest exception to the extraction rule: it was built
engine-first, against a named first consumer (the platform's own builder portal, whose
AI turns must be billed) with the second — vertical AI features — in sight rather than
in hand. The decision log carries that caveat rather than glossing it; the discipline it
follows instead is a design document reviewed before code, and the same
one-invariant-set smallness as its extracted siblings.

Planned next, in the order verticals force them: **scheduling/dispatch** and
**ticketing** (ärende).

## How these pages are organized

Every engine documents itself the same way, in the same five pages. The shape is a
contract: a page that has nothing to say is a finding, not an omission.

| Page | Answers |
|---|---|
| **index** | *Is this a good match?* — what it owns, what it won't do, when to reach for it |
| **Domain model & invariants** | the tables, and the rules the engine will not let you break |
| **Operations, functions & permissions** | the callable surface, and which parts are composable |
| **Events** | what it emits and consumes, payload contracts, versioning |
| **Composing & extending** | using it from a vertical, configuration, the connector seam |

Two conventions worth knowing before you read:

**Engines have no endpoints.** They expose *operations* (named handlers invoked through a
scope stub, each doing its own permission check) and *in-scope functions* (plain exports a
vertical calls inside its own transaction, where the caller owns the check). Any HTTP surface
is generated from the manifest's `api` field, never hand-written. The split between those two
surfaces **is** the extension model, which is why every engine has a page for it.

**Engines take no configuration.** `registerModule` accepts one frozen constant; there is no
options object, no factory, and no `config` field on the manifest. When behaviour must vary,
you compose (your own operation calling in-scope functions), declare (a guard predicate with
its own kernel-opaque config), store (tenant content as data in the scope), or gate (the
entitlement flag). *Configuration is dynamic; composition is code.* The Composing page of
each engine says which of those applies, and admits where the engine doesn't yet allow it.
