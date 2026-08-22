---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/vertical-host': minor
'@substrat-run/engine-workorder': minor
'@substrat-run/engine-invoicing': minor
'@substrat-run/engine-protocol': minor
---

A list read declares its filter and sort vocabulary, and the kernel composes the walk
behind it (#811, K-41).

K-18 promised *"engine list APIs accept registry-declared filter/sort predicates with
correct pagination and counts, the kernel composing the join inside the scope DB"* and
nothing implemented it. Twelve reads across four engines and four demos answered with whole
tables, and `engines/*` carried ~36 hand-written `ORDER BY` clauses, none of them
caller-selectable — so a vertical wanting a different sort had no path but to fork the
engine, which is the signal CLAUDE.md names as the engine having drawn its line wrong.

**`paged` is now a union of two halves, not one shape with optional fields.** Declare `over`
and the kernel composes the `WHERE`, the `ORDER BY`, the keyset comparison, the `LIMIT` and
the matching `COUNT` from your entity's declared columns — and provisions the indexes behind
them, which is the reason this is kernel-layer rather than a query helper in contracts. A
declared filter with no index is a table scan that passes every test and degrades when one
tenant's table grows. The columns are compile-checked against the entity registry, and the
manifest fragment the kernel indexes from is *derived* from the operations
(`listsDeclaredBy`), the way emitted events already are.

```ts
paged: {
  over: { entity: 'workorder', sortable: ['number', 'status'], filterable: ['status'] },
  order: 'desc',
}
```

```ts
return mapPage(ctx.page<OrderRow>('workorder', { ...input, filters }), toWorkOrder);
```

The kernel returns rows; the projection and any hydration stay yours. This is not a
generated-CRUD layer — it invents no routes and no handlers. Adoption also *bounded* three
N+1 reads: a hydration that ran once per row in the scope now runs once per row on the page.

**The other half is not a legacy path.** Five reads cannot be kernel-composed and say so:
`callout/timeline` walks `_substrat_outbox` (a kernel table, not a registry entity),
`protocol/list-templates` selects through a correlated `MAX(version)` subquery, and three
portal reads decide visibility by a per-row proof walk. They declare `sortKey`, own their
`WHERE`, and still page. `pageVisible` is the helper for the permission-filtered case: it
over-fetches and advances the cursor by the last row **examined**, so rows the walk rejects
still move it forward. Its pages may come back short, and a short page does not end the
walk — only the absent `Link` does.

**Every kernel-composed walk carries a tie-break.** A keyset over a non-unique column drops
rows — `status > 'open'` excludes its own ties — so the walk runs over `(sortColumn, id)`
and the cursor is the `|`-joined composite `pagination.ts` had already pinned with nothing
producing one. That is also why `over.entity` is pointable-only.

**The gate.** `defineOperations` refuses at module load an operation whose `output` is a bare
`z.array(...)` with no `paged`. #811 asked for a `lint:model` gate; a tool has to *find* the
declarations, and the ones it would have missed are exactly the four engines this issue was
filed about. At load it reaches every module, and it immediately found two unbounded reads a
hand survey had missed.

**The platform supplies the page.** `mountOperations` parses `limit`/`cursor`/`order`/`sort`
with the one shared schema and merges them into the input, so the default page size and the
`LIST_PAGE_MAX` ceiling are true of the surface rather than of the operations whose author
remembered to restate them. An over-limit request is refused, not silently capped — a caller
handed 200 of the 100 000 they asked for cannot tell a capped page from the end of a walk.

**Breaking, in process only** — `minor` rather than `major` because these engines are 0.x,
where semver puts a breaking change, and because `major` would mint 1.0.0 and claim a
stability milestone the fleet has not declared. The break is stated here instead.

`workorder/list`, `invoicing/list`, `protocol/list-templates` and
`protocol/list-for-entity` now return `Page<T>` instead of `T[]`, and
`listOrders(ctx, status?)` becomes `listOrders(ctx, page)`. Every call site is a compile
error, which is how all twelve conversions were found. It is **not** a wire break: #829 moved
the walk to `Link`/`X-Total-Count` headers, so a paged read's HTTP body is still the entries
array. `getWorkOrder(ctx, orderId)` is new — added because paging exposed two verticals
reading every row in the scope to `.find` one.
