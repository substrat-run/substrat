---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/contract-tests': minor
'create-substrat': patch
'@substrat-run/docs': patch
---

**Archive and trash operations are derived handlers (#119).** An entity that declares `archive: { permission }` or `trash: { permission }` no longer needs a hand-written handler for its moves or its bin. Declare the operation with `derive` and the platform writes it:

- `derive: 'archive'` / `'unarchive'` / `'trash'` / `'restore'`: a `POST` whose input is the id alone, checked on that row (`permission: { key, entity, idFrom }`) under the key the entity declares for the move: its archive key for archive and unarchive, its trash key for trash and restore. It answers the new `entityStateOutput` schema (`{ id, state }`) and declares no `emits`, because the kernel announces the move. A `restore` declares `trashed: 'admits'`, and the other three must not.
- `derive: 'trashed'`: the bin. A `GET` page (`paged.over`) of an entity that declares `trash`, answering its `fields`. It declares `narrows` checking exactly the trash key and no leading check, because `ctx.pageTrashed` checks the key on every row. Optional inputs are declared filters.
- A derived `list` over an entity that declares `archive` may take one optional `view: z.enum(['active', 'archived'])` input, passed to `ctx.page`. Without it the page is the active rows.

`@substrat-run/contracts` exports `entityStateOutput` and the `EntityMoveKind` type, and `DERIVED_KINDS` grows to nine. `@substrat-run/kernel` writes the five new handlers through the existing verbs, adding no `ctx` surface. `@substrat-run/contract-tests`' derived-handler suite holds them on both adapters.

**Compatibility.** `defineOperations` already refuses, at module load, an operation of a derivable shape that declares neither `derive` nor `authored` (#1773). The new shapes join that check. An operation that matches one exactly, including answering `entityStateOutput` itself, must now declare it. The error names the operation and the shapes it matches, for example `derivable from the model as \`archive\` or \`unarchive\``. Archive and unarchive declare the same shape, so the error offers both, and `derive` says which move it is.

The one-word migration: add `derive: 'archive'` (or the move it is) to the declaration, delete its handler, and use `entityStateOutput` as its output. Or, to keep the handler, declare `authored: '<why>'`. An operation answering its own `{ id, state }` schema is not matched, and is unaffected.
