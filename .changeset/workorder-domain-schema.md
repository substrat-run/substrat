---
"@substrat-run/engine-workorder": minor
---

`WorkOrder` becomes schema-first, and the row schema's docs stop overclaiming.

`workorderRow` was described as "the row shape, for a vertical declaring an
operation that returns one". The first half is true and the second is not: the
engine **stores** `facility_type` / `facility_id` as two snake_case columns and
**publishes** one `EntityRef` in camelCase. A vertical declaring
`output: workorderRow` would have been declaring the wrong shape, and confidently.

`workOrder` is the published type, exported as a Zod schema with the interface
derived from it — matching `billableLine` and `createWorkOrderInput`, which were
already schema-first. `status` is taken from the entity registry, so storage and
domain cannot disagree about the state set.

The row schema keeps its place; its documentation now says what it is, and names
`workOrder` as what operations return.
