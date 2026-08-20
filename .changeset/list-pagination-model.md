---
'@substrat-run/contracts': minor
'@substrat-run/vertical-host': patch
---

Paged reads become a declaration the compiler and the document both understand (#811).

The keyset pagination convention has existed in `contracts/pagination.ts` since the admin
log — `?limit&cursor&order` in, `{ entries, nextCursor }` out, keyset never offset — and
was adopted across the control plane, dashboard and console. Engines and verticals never
adopted it, so their list reads still return whole tables. This is the seam that lets them.

An operation declares `paged`, and `output` then carries the **entry** shape:

```ts
'todo/list-items': {
  permission: { key: 'list:contribute', entity: 'list', idFrom: 'listId' },
  input: z.object({ listId: z.string(), limit: …, cursor: … }),
  output: todoEntities.item.fields,   // the ENTRY, not the envelope
  paged: { sortKey: 'id' },
  http: { method: 'GET', path: '/lists/{listId}/items' },
}
```

- `sortKey` is a **compile-checked join** onto the output's own fields, the same idiom as
  `entityIdFrom` and for the same reason: a cursor over a field the entry does not have is
  a page that silently skips or repeats rows, and nothing downstream would flag it.
- `HandlerOutput` derives `Page<Entry>` for the handler, so declaring `paged` and
  returning a bare array does not compile. That derivation lives in contracts rather than
  in each vertical's `satisfies` clause — one place to be right about the envelope.
- The emitted OpenAPI grows `limit` / `cursor` / `order` query parameters and the
  `{ entries, nextCursor }` response schema, built with the same `pageSchema` the handler
  is typed against, so document and code cannot disagree.

A **total count is opt-in**, because you cannot get one from a keyset page for free and
business software asks for it constantly:

```ts
paged: { sortKey: 'id', total: true },
```

The handler then returns `countedPageOf` instead of `pageOf`, and the compiler holds it to
that — swapping one for the other is a type error, not a missing field discovered in the
UI. The number counts the **filtered** set, the same `WHERE` the page ran under: counting
the table instead is the mistake that looks right until a second list exists, so there is a
test for exactly that.

`todo/list-items` adopts it end to end — declaration, keyset SQL, route, artifact — as the
worked example the next vertical copies. Its `ORDER BY created_at, id` collapses to
`ORDER BY id`: a ULID is creation-ordered, so that is the same sequence with one fewer
column, and a cursor can name it.

Tested where it can actually break. The scenario suite walks a five-row list two at a time
and asserts every row exactly once with no trailing empty request, then adds a row
*between* two pages and proves the next page does not repeat one — the property an offset
cannot promise on a table being written to. And because scenario suites invoke operations
directly and never touch the HTTP layer, `vertical-host` drives `?limit=2&cursor=…` through
a real Hono app to prove the query string arrives coerced to a number rather than as
`'2'`.

Nothing else changes: no other operation declares `paged`, so no other list read moves.
The remaining adoptions, and the lint that fails an undeclared `z.array()` output, follow.
