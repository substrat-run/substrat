# @substrat-run/demo-todo

## 0.2.0

### Minor Changes

- bb5f3ac: Todo adopts the two platform surfaces it was behind on: the error taxonomy (#113) and
  declared search (#827).

  **Errors.** Five bare `throw new Error` became `substratError` — four `not_found`, and
  "you were never invited" as `precondition_failed`. All seven engines had adopted the
  taxonomy; no demo had, so every vertical was still classified by `classifyError`'s
  message-pattern fallback, the tier its own comment calls a guess. The statuses were
  already drifting: `'no account here …'` matched no pattern and fell through to 400, while
  `'nobody here with that address'` matched todo's own regex and answered 404 — two
  near-identical preconditions separated by prose. `routes.ts` no longer matches on this
  vertical's error text at all; what is left is the two pieces of _platform_ vocabulary the
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
  every hit is filtered _after_ ranking, and a ranked top-N filtered afterwards returns fewer
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

### Patch Changes

- Updated dependencies [885ccf8]
- Updated dependencies [31ab573]
  - @substrat-run/contracts@0.82.0
  - @substrat-run/vertical-host@0.82.0
  - @substrat-run/adapter-sqlite@0.82.0
  - @substrat-run/kernel@0.82.0

## 0.1.10

### Patch Changes

- Updated dependencies [9cfb99d]
  - @substrat-run/contracts@0.81.0
  - @substrat-run/kernel@0.81.0
  - @substrat-run/adapter-sqlite@0.81.0
  - @substrat-run/vertical-host@0.81.0

## 0.1.9

### Patch Changes

- Updated dependencies [83b0ca3]
  - @substrat-run/contracts@0.80.0
  - @substrat-run/vertical-host@0.80.0
  - @substrat-run/adapter-sqlite@0.80.0
  - @substrat-run/kernel@0.80.0

## 0.1.8

### Patch Changes

- Updated dependencies [48ddee6]
- Updated dependencies [43d67cb]
- Updated dependencies [bb32545]
  - @substrat-run/contracts@0.79.0
  - @substrat-run/kernel@0.79.0
  - @substrat-run/vertical-host@0.79.0
  - @substrat-run/adapter-sqlite@0.79.0

## 0.1.7

### Patch Changes

- Updated dependencies [d3c6d31]
  - @substrat-run/contracts@0.78.0
  - @substrat-run/adapter-sqlite@0.78.0
  - @substrat-run/kernel@0.78.0
  - @substrat-run/vertical-host@0.78.0

## 0.1.6

### Patch Changes

- Updated dependencies [cbc4538]
  - @substrat-run/contracts@0.77.0
  - @substrat-run/adapter-sqlite@0.77.0
  - @substrat-run/kernel@0.77.0
  - @substrat-run/vertical-host@0.77.0

## 0.1.5

### Patch Changes

- Updated dependencies [e3c3e2b]
  - @substrat-run/vertical-host@0.76.0
  - @substrat-run/contracts@0.76.0
  - @substrat-run/kernel@0.76.0
  - @substrat-run/adapter-sqlite@0.76.0

## 0.1.4

### Patch Changes

- Updated dependencies [89c2113]
- Updated dependencies [20818ce]
  - @substrat-run/kernel@0.75.0
  - @substrat-run/adapter-sqlite@0.75.0
  - @substrat-run/vertical-host@0.75.0
  - @substrat-run/contracts@0.75.0

## 0.1.3

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0
  - @substrat-run/vertical-host@0.74.0
  - @substrat-run/adapter-sqlite@0.74.0
  - @substrat-run/kernel@0.74.0

## 0.1.2

### Patch Changes

- Updated dependencies [3b8533d]
  - @substrat-run/contracts@0.73.0
  - @substrat-run/adapter-sqlite@0.73.0
  - @substrat-run/kernel@0.73.0
  - @substrat-run/vertical-host@0.73.0

## 0.1.1

### Patch Changes

- Updated dependencies [f869541]
- Updated dependencies [f869541]
- Updated dependencies [19fb697]
- Updated dependencies [f869541]
- Updated dependencies [717600e]
- Updated dependencies [46b1cac]
- Updated dependencies [9208b4e]
  - @substrat-run/kernel@0.72.0
  - @substrat-run/adapter-sqlite@0.72.0
  - @substrat-run/contracts@0.72.0
  - @substrat-run/vertical-host@0.72.0
