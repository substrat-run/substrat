# Operations, functions & permissions

An engine has **no endpoints**. It exposes operations (invoked through a scope stub) and
in-scope functions (called by a vertical inside its own transaction). HTTP, where it exists,
is a generated artifact pointed at by the manifest's `api` field.

Most of this engine's surface, though, isn't either one — it's the **consumers**. Lines
arrive by event, not by call. See [Events](./events).

## Operations

| Operation | Permission | Does |
|---|---|---|
| `invoicing/list` | `invoicing:read` | list underlag (optionally by status), each with its computed total |
| `invoicing/get` | `invoicing:read` | one underlag with all lines and total |
| `invoicing/export` | `invoicing:export` | flip to `exported` — the point of no return |

There is no `create` and no `add-line`: an underlag is never authored, only accumulated. The
only way to put a line on one is to emit an event this engine consumes. That is the design —
a basis nobody can hand-write is a basis nobody can forge.

## In-scope functions

**This engine exports none, deliberately.** All three operations carry their logic inline.

::: tip Composed by event, not by call — the absence is the design
An engine is composed one of two ways, and that decides its shape. A **by-call** engine —
work orders, bookings, protocols — keeps its logic in exported in-scope functions, and its
operations are thin, so a vertical wraps the functions inside its own transaction. Invoicing
is the **by-event** one: a vertical does not build an invoice basis, it emits a billable fact
and this engine's consumers build the basis from that event's payload. Here the operations
*are* the surface, and their logic living in them is correct rather than an omission.

The missing exports are load-bearing. This engine is the **only writer of its rows**, which
is what keeps `exported` genuinely immutable: a caller cannot export an underlag half-way
through a delivery that is still appending lines to it. Extracting `exportUnderlag(ctx, …)`
for a vertical to call would hand out exactly that race, so it is not a purely additive
change — it is a change of who owns the invariant. Compare the
[work-order engine](/engines/workorder/surface#in-scope-functions), which exports
`createWorkOrder`, `completeWorkOrder`, and friends precisely because a vertical is meant to
wrap them.
:::

So a vertical reaches the result by reading it back, not by calling in: through
`invoicing/list` / `invoicing/get`. `invoicing.underlag-updated` is the *notification* that
there is something new to read — it carries `{ underlagId, addedLines, source }`, not the
whole basis — so a vertical projects it into its own side table keyed by the underlag's id
(decision 28) and calls `invoicing/get` when it needs the basis and its computed total. The
cost is real and worth stating
plainly: a vertical **cannot** export an underlag and touch its own tables in one
transaction, and cannot wrap export in its own vocabulary. That is what the immutability
guarantee is bought with.

What *is* exported: `INVOICING_PERM`, `invoicingManifest`, `invoicingMigrations`, the
`UnderlagRow` / `UnderlagLine` row types, and `invoicingModule`.

## Permissions

| Key | Description |
|---|---|
| `invoicing:read` | Read invoice basis |
| `invoicing:export` | Export an invoice basis (makes it immutable) |

Two keys, and the split is the point: reading a basis is routine, and **export is
irreversible**. Keep `invoicing:export` on a back-office role, not on whoever can see totals.

## Entitlement

`entitlementKey: 'invoicing'`. This engine is priceable independently of any other — a tenant
can hold `workorder` without `invoicing`. The gate is checked per invoke and fails closed.

::: warning The entitlement gate is on operations, not consumers
`dispatch` iterates every registered module's consumers with **no entitlement check** — only
`invoke` consults `operationEntitlement`. So if the invoicing module is registered on the
host, an unentitled tenant's `workorder.completed` events still build underlag rows in their
scope; they simply can't `list`, `get`, or `export` them.

"Not entitled" therefore means *invisible*, not *inert* — the accumulation happens either way.
Grant the entitlement later and the history is already there, which is convenient, but it is
not what "a module loads for a tenant only if the tenant holds its SKU flag" implies. Worth
knowing before you price this engine as off.
:::
