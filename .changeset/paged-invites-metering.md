---
'@substrat-run/engine-invites': minor
'@substrat-run/engine-metering': minor
'@substrat-run/contracts': minor
---

**Non-additive: five list operations now answer a page instead of an array.**
`invites/list`, `metering/list-meters`, `metering/list-entries`,
`metering/list-periods` and `metering/period-lines` each declared a single entity as
`output` while their handler returned an unbounded array — so the gate that refuses a
bare list never saw one, and the OpenAPI document and the generated client both
described one object where the runtime sent every row. Each now declares `paged` and
returns `Page<T>`; a caller takes `.entries` and walks `nextCursor`.

The **in-scope** functions (`listInvites`, `listMeters`, `listEntries`, `listPeriods`,
`periodLines`) are unchanged and still return arrays — a vertical composing one inside
its own transaction is folding it, not rendering a table. `listInvites` does now order
by `id` (a ULID, so the same "newest first") rather than by `created_at`, which is not
unique and cannot carry a keyset cursor.

`@substrat-run/contracts` gains `pageOverFold` and `CURSOR_FIELD_SEPARATOR` — the
handler-composed paging helper `engines/absence` had written locally, now shared rather
than copied into two more engines.
