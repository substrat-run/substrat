---
'@substrat-run/contracts': minor
'@substrat-run/model-emit': minor
---

`EntityDef` can express a primary key that is not `id`, and a table with no
primary key is now refused rather than emitted.

`EntityDef` assumed the identity of a row was an `id` field. Where it was not,
`emitTables` emitted the table **with no primary key at all** — silently. A
production vertical transcribing 63 entities from a 38-version journal that has
run against real data hit this on 15 of them, seven of those composite (#804):

| table | journal | emitted |
|---|---|---|
| `vertical_workorder_ext` | `PK(workorder_id)` | none |
| `vertical_time_budget` | `PK(customer_id, year, month)` | none |
| `vertical_number_sequence` | `PK(kind, year)` | none |

It is not a niche shape. The first is the `vertical_` side table keyed by an
engine's id — the composition pattern the design rules prescribe. Its identity
*is* the work order's; an `id` of its own would permit two side rows for one
work order, which is the thing a primary key exists to prevent. So any vertical
composing an engine the way the rules describe hits this on its first side
table. The rest are ordinary value-keyed tables: a counter per `(kind, year)`, a
budget per `(customer, year, month)`.

**The silence was the part worth fixing first.** That vertical's own parity check
compared column names, types and nullability across all 63 tables and reported
63/63 matching — because it never compared primary keys. The emitted schema would
have accepted duplicate rows in 15 tables, and nothing said so.

So the refusal comes before the notation. `primaryKeyOf` resolves an entity's key
or throws, and both `emitTables` and `emitModel` go through it: an entity with
neither an `id` field nor a `primaryKey` now names itself in an error instead of
producing a keyless table, and `lint:model --check` goes red on it too.

Then the notation:

```ts
ext: {
  table: 'vertical_workorder_ext',
  fields: z.object({ workorder_id: z.string(), route_note: z.string().nullable() }),
  primaryKey: ['workorder_id'],           // → workorder_id TEXT PRIMARY KEY NOT NULL
},
budget: {
  table: 'vertical_time_budget',
  fields: z.object({ customer_id: z.string(), year: z.number(), month: z.number(), hours: z.string() }),
  primaryKey: ['customer_id', 'year', 'month'],   // → PRIMARY KEY (customer_id, year, month)
},
```

`primaryKey` defaults to `['id']`, so nothing already declared changes and no
checked-in `model.json` moves — an id-keyed entity emits the byte-identical DDL
it did before. It is kept distinct from `key` because SQL's own distinction is
the useful one: `primaryKey` is identity, `key` is an additional uniqueness rule,
and a table legitimately has both. Reading `key` as the primary key when an
entity has no `id` would have saved a field by conflating two facts. Column order
is preserved rather than sorted, unlike `key` — a composite primary key is also
the index its columns are searched by, left to right.

The columns are checked the way the rest of the emitter checks: a `primaryKey`
naming a field the entity does not have is a compile error, and a nullable key
column is refused, because SQLite lets a NULL into a non-INTEGER primary key and
would not catch it either.

**And the planner can see it now.** `journalPrimaryKeys` joins `journalColumns`
and `journalUniques` as the third reader, handling both spellings journals use
(inline for one column, table-level for several) and replaying renames, rebuilds
and drops like its siblings. `planMigration` emits the key on a new table and
refuses a moved one — SQLite cannot change a primary key in place, so that is a
rebuild and a decision about the duplicate rows already in there, not a diff. It
distinguishes "the journal built this table without a key" from "the journal
never built it", because only one of those is a bug.

The demo parity tests now compare primary keys per table, and fail on the case
that started this: both sides agreeing that neither has one.
