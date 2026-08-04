---
'@substrat-run/console': minor
---

Scopes view: search, facet filters, real pagination, and bulk lifecycle actions.
The fleet directory was a single "Load more" list with no way to find or act on
scopes in bulk. It now carries a free-text search (name / slug / tenant / vertical
/ kind / id) plus Tenant, Vertical, and Jurisdiction filters, and replaces the
"Load more" footer with client-side pagination (25/50/100 per page, prev/next,
"showing X–Y of Z").

Rows are selectable, with a header select-all that spans every filtered row across
pages — so "filter to Archived → select all → reap" is one gesture. The bulk bar
offers only the lifecycle transitions legal for at least one selected scope
(unsuspend / restore / suspend / archive / reap), each labelled with its eligible
count and applied only to that eligible subset. Reap — the one irreversible action
— is armed behind a confirmation that lists the affected scopes and requires typing
the exact count, the bulk analogue of the existing type-the-slug gate. Each bulk
action fans out the existing per-scope endpoints, so every transition stays its own
audited control-plane action; no new bulk API surface is added.

Internally the view now reads the already-walked fleet directly instead of
re-fetching a paged window (the parent already loads the whole directory via
`walkAll`), so search and cross-page select-all operate over the full set.
