---
'@substrat-run/engine-invoicing': minor
---

Split document-level from per-line provenance on `invoicing_lines` (#328). The
`workorder.completed` payload has always required a per-line `sourceType`
(`time`/`material`) and `sourceId`, but both were parsed and then discarded:
every consumer wrote *document*-level provenance — a literal `'workorder'` /
`'order'` / `'timesheet'` and the delivery id — into the per-line `source_type` /
`source_id` columns, identically for every line. A producer was required to build
data the engine dropped, and `invoicing_lines.source_type` answered "which
consumer wrote the row" while its name promised "what the line is".

New columns `document_type` / `document_id` now carry the delivery provenance
(always known, so `NOT NULL`, and the idempotency key each consumer dedups on).
`source_type` / `source_id` are freed to carry the real per-line provenance and
are nullable — populated on the workorder path, `NULL` where a producer supplies
none (commerce, timesheet). Migration `0002-split-line-provenance` rebuilds the
table and backfills existing rows' document provenance from the old columns,
leaving per-line provenance `NULL` (it was never captured, so it is not invented).

Consumers that read a line's `source_type`/`source_id` expecting the document
value must switch to `document_type`/`document_id` (the id that links a line back
to its originating work order or retail order now lives there).
