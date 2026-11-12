# @substrat-run/elements

## 0.8.1

### Patch Changes

- Updated dependencies [0dab770]
  - @substrat-run/contracts@0.194.0

## 0.8.0

### Minor Changes

- 0ed73dd: - contracts: the assistant stream's `source` event takes an optional `kind` (an open string, so a new kind never makes an older reader drop the citation) and `detail` (a short line saying where the source lives).
  - elements: `<sub-assistant>` draws an icon for a source whose `kind` is in `ASSISTANT_SOURCE_KINDS` and its `detail` quietly after the title, with new parts `source-icon` and `source-detail`; `AssistantCitation` carries both.

### Patch Changes

- Updated dependencies [0ed73dd]
- Updated dependencies [15e97c6]
  - @substrat-run/contracts@0.193.0

## 0.7.1

### Patch Changes

- @substrat-run/contracts@0.192.0

## 0.7.0

### Minor Changes

- de3a769: `<sub-kanban>`: cards in columns, moved between states by drag (a tilted lift, an opening gap, auto-scroll, a long press on touch) or by keyboard, with lifecycle refusals, WIP limits, `moveTo`, optimistic saves that roll back on failure, and an inline field for adding a card. `/kanban` and `/kanban-model` subpaths.

## 0.6.1

### Patch Changes

- @substrat-run/contracts@0.191.0

## 0.6.0

### Minor Changes

- 1e8ccbb: `<sub-assistant>`: a conversation with the assistant as one element, with `AssistantModel` beside it at `/assistant-model`.
- 7f8573e: `<sub-entity-table>` can back a list people work in: screen-owned selection with range gestures, double-click and keyboard open, `paging="scroll"`, row action icons and a "More" menu, right-click and drag hooks, and nested rows.

### Patch Changes

- cd1c0d4: `<sub-entity-table>`: a re-read keeps every batch "Load more" added, and "Load more" waits for a re-read in flight instead of appending rows from the old order.
- Updated dependencies [c9db03c]
- Updated dependencies [f0dd3fe]
- Updated dependencies [3c0c8e8]
  - @substrat-run/contracts@0.190.1

## 0.5.0

### Minor Changes

- 42b800b: `@substrat-run/elements/controls` registers `wa-badge`, `wa-breadcrumb`, `wa-card`, `wa-dialog`, `wa-divider`, `wa-tab-group` and `wa-textarea` too, and `themes/base.css` carries `wa-visually-hidden-label`, so an app reaches Web Awesome through this package alone.
- f6ca1e8: Add a subpath per module (`/avatar`, `/user-menu`, `/entity-table`, `/entity-table-model`, `/session`), so an app using one element no longer ships them all.

## 0.4.0

### Minor Changes

- 9735a33: `<sub-entity-table>`: a column can take a `width`, `row-click` fires `sub-row-click` for a click on a row, and `detail` with `expanded` opens a detail row under a row.

## 0.3.0

### Minor Changes

- aedb15c: `session-url=""` on `<sub-user-menu>` and `<sub-avatar>` reads nothing, for a host that sets `session` itself: React sets that property only after the element is connected, so the default URL used to be asked first.

## 0.2.0

### Minor Changes

- 6b1a031: `<sub-entity-table>` reads with a query (`source.read(query)`): sortable headers, views, equality filters, a search mode (`searchViews`), Previous / Next paging with a page-size picker (`paging`, `page-size`), selection with bulk actions, typed cells (`kind`), `render` and light-DOM `mount` cells, `--sub-table-*` tokens, `::part()`s and `density="compact"`. `queryToParams` / `queryFromParams` keep a table's query in the URL, and `column-picker` (opt-in) shows, hides and reorders columns, remembered with `layout-key`.

### Patch Changes

- 30206b7: Ship the Apache-2.0 LICENSE in the package, point `homepage` at its reference page, and clear `dist` before each build so a removed theme is not published.

## 0.1.0

### Minor Changes

- c6654f7: First published release: `<sub-entity-table>`, `<sub-user-menu>`, `<sub-avatar>` and the shared session read, built to `dist` with the themes beside them.
