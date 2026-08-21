---
'@substrat-run/engine-invoicing': minor
'@substrat-run/demo-manyfold': minor
'@substrat-run/demo-shop': minor
---

Invoicing, manyfold and shop declare their state machines (#844).

**shop** — a real bug. Both order guards threw a bare `new Error(...)`, so fulfilling an
already-fulfilled order answered **500** where every engine answers **409**. Nothing was
red: the scenario test matched `/invalid transition/`, which a bare `Error` carries just as
well as a `conflict`. Declaring the machine also surfaced that `cancelled` is in the enum
and in the migration's `CHECK` and **nothing ever writes it** — `states` must be total, so
the dead state could not stay invisible. It is left declared rather than quietly dropped;
removing it is a migration and a product decision.

**manyfold** — replaced a `Record<EntryStatus, EntryStatus[]>` keyed by *target* state. That
table could say `approved` may become `in_review`; it could not say which verb does it, so
the answer lived in whichever operation happened to pass that target. It also threw a bare
`Error`. `ENTRY_STATUSES` now reads the column's own `z.enum` instead of being a separate
`const` array, and `status` is typed on the column rather than left `z.string()`.

**invoicing** — two states, one edge, and the pattern for guards whose reason is better than
`invalid_transition`: `transitionFor` answers the legality question from the declaration
while the engine keeps `immutable_after_export`, which is the invariant a caller needs to
hear. Composed by event, so the declaration records in the reviewed artifact that no
consumer may move the state.

`lint:model` now also looks for `src/model.ts` in a vertical, because a lifecycle is
declared beside the operation map that imports the entities — so `entities.ts` cannot emit
it without a cycle.

One visible change: manyfold's publish refusal now reads
`invalid transition: post entry is 'draft', but 'manyfold/publish' requires approved`
instead of its own hand-written sentence. Its scenario test asserts the new message.
