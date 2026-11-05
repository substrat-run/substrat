---
'@substrat-run/elements': minor
---

`<sub-entity-table>` reads with a query (`source.read(query)`): sortable headers, views, equality filters, a search mode (`searchViews`), Previous / Next paging with a page-size picker (`paging`, `page-size`), selection with bulk actions, typed cells (`kind`), `render` and light-DOM `mount` cells, `--sub-table-*` tokens, `::part()`s and `density="compact"`. `queryToParams` / `queryFromParams` keep a table's query in the URL, and `column-picker` (opt-in) shows, hides and reorders columns, remembered with `layout-key`.
