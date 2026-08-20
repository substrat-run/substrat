---
'@substrat-run/demo-todo': minor
---

Todo adopts the two platform surfaces it was behind on: the error taxonomy (#113) and
declared search (#827).

**Errors.** Five bare `throw new Error` became `substratError` — four `not_found`, and
"you were never invited" as `precondition_failed`. All seven engines had adopted the
taxonomy; no demo had, so every vertical was still classified by `classifyError`'s
message-pattern fallback, the tier its own comment calls a guess. The statuses were
already drifting: `'no account here …'` matched no pattern and fell through to 400, while
`'nobody here with that address'` matched todo's own regex and answered 404 — two
near-identical preconditions separated by prose. `routes.ts` no longer matches on this
vertical's error text at all; what is left is the two pieces of *platform* vocabulary the
mount still has no opinion on.

**Search.** One declaration in the manifest:

```ts
...manifestEntities(todoEntities, {
  searchables: [{ entityType: 'item', fields: ['text'] }],
}),
```

`item` only, and only `text`. `list.name` would index a handful of rows already on screen,
and `owner`/`share` carry the app's only `erasable` fields — an index over an address is a
second copy of it.

Two reads, because todo has two questions. `GET /lists/{listId}/items/search` is the read
`paged` took away: filtering `list-items` in the browser searched whatever page had loaded.
`GET /items/search` is "where did I put milk?", and declares `narrows` for the same reason
`my-lists` does — nobody holds `list:contribute` scope-wide, so reachability is only ever a
question about the list an item sits on, asked once per distinct list rather than once per
hit.

Both over-fetch on purpose. `ctx.search` checks nothing and the index is scope-wide, so
every hit is filtered *after* ranking, and a ranked top-N filtered afterwards returns fewer
than N. `TODO_SEARCH_MAX` is derived as `MAX_SEARCH_LIMIT / SEARCH_OVERFETCH` so the
widened ask always stays inside the kernel's ceiling — declaring the ceiling itself as the
bound leaves the over-fetch no headroom at exactly the limit where it matters most.

**Also:** todo now serves its own `/openapi.json`. `api.ts` claimed it did and nothing
did — the document existed only as the checked-in review artifact, with `tools/api-diff.mts`
as its sole consumer. No `/api/docs` page: rendering one means bundling Scalar, and the
smallest vertical that is still a real one does not need a second dependency to prove its
document is reachable.

The search index is provisioned by the kernel, appended to this module's migrations rather
than journaled here — so `emit:migrations --check` stays green and the DDL
(`search/item:prefix:text`) does not appear in this diff. It is idempotent and back-fills.
