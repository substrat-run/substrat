---
"@substrat-run/contracts": minor
---

An entity registry, so the manifest's entity names have something to be checked against.

The manifest describes permissions, events, guards, schedules, attachment
targets, entity relations, searchables and UI contributions. It does not
describe **entities**. `migrations` is a pointer (`journalDir` +
`compatibleFrom`), the tables live in raw SQL the manifest never sees, and
entity *type names* appear only as bare `z.string().min(1)` fragments across
four unrelated, individually optional features — `attachmentTargets`,
`entityRelations`, `searchables` and `ui.entityViews`.

Nothing checked those four against each other or against the tables. A typo'd
`parentType` parsed cleanly and produced an edge permission never flows along:
the tuple evaluator walks a relation that does not exist, and a grant that should
reach a child silently does not. Now:

```
Type '"custmer"' is not assignable to type '"contract" | "customer"'.
  Did you mean '"customer"'?
```

`defineEntities` declares them; `manifestEntities` composes the
entity-referencing manifest fragments against that declaration. Checked: every
`entityType` in `attachmentTargets`, `searchables` and `ui.entityViews`; `key`
and `erasable` against the entity's own fields; and `searchables.fields` against
the *named* entity's fields — the only place a field name appears in the manifest
today, and nothing checked it.

`entityRelations` is **derived** from the entities' `parent` declarations rather
than written a second time. Two descriptions of one fact is how they come to
disagree, and this disagreement is invisible.

`emitModel` renders the registry to plain JSON, deterministically (sorted
entities, sorted `key`/`erasable`, field schemas via `z.toJSONSchema` — the same
conversion the OpenAPI builder already uses, so no second schema language enters
the pipeline). **This is the artifact of record**: everything downstream should
read it rather than the TypeScript, which is what keeps the authoring notation
swappable — a later change of authoring layer becomes a new emitter writing the
same JSON, and nothing downstream notices.

Additive and opt-in: nothing existing declares entities, no manifest changes
shape, and the whole monorepo builds and typechecks unaltered.

**Not included, deliberately.** No `lint:model --check` tool yet. No vertical
declares entities, so a checkpoint would scan nothing — and per
`tools/permission-diff.mts`'s own rule, *"a checkpoint that checked nothing must
never print a green light."* The tool lands with the first adopter.

`packages/contracts` also gains a `tsconfig.test.json` and a `test` script: its
`tsconfig.json` includes only `src`, so nothing in `test/` was typechecked, and
the package had no test wiring at all. `test/model.test.ts` is the feature rather
than a test of it — a type-level constraint fails *permissively*, so written the
obvious way every check compiles clean and enforces nothing. Both directions were
verified: removing a `@ts-expect-error` surfaces the real error, adding a bogus
one is reported unused.
