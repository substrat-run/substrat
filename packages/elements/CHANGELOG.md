# @substrat-run/elements

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
