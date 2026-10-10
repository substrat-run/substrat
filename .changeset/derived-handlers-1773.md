---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/contract-tests': minor
'@substrat-run/engine-absence': patch
'@substrat-run/engine-booking': patch
'@substrat-run/engine-invites': patch
'@substrat-run/engine-invoicing': patch
'@substrat-run/engine-metering': patch
'@substrat-run/engine-protocol': patch
'@substrat-run/engine-workorder': patch
'create-substrat': patch
'@substrat-run/docs': patch
---

**Breaking:** an operation whose handler the model describes completely must say who writes that handler (#1773). After upgrading, `defineOperations` refuses at module load any operation of a derivable shape that declares neither, and the error names the operation, the shape and the remedy:

- Declare `derive: '<shape>'` and delete the handler. `operationsFor` no longer asks for it and supplies the platform's.
- Or keep the handler and declare `authored: '<what the derived handler would get wrong here>'`.

The derivable shapes, each matched exactly:

- `get` is served as `GET`, its input is the id alone, its output is the entity's own `fields`, and it emits nothing.
- `list` is a `paged.over` page of the entity's own `fields`. Every input is a declared `filterable` column of the same type, and a check narrowed to a parent scopes the page to that parent.
- `update` is a `PATCH` narrowed to the row, with `concurrency` over it, emitting about it and answering with its `fields`. Absent fields are left alone and `null` clears.
- `delete` is a `DELETE` narrowed to the row, emitting about it and answering `{ id, deleted }`, on an entity that no other entity declares as parent.

What changes:

- `@substrat-run/contracts` adds `derive` and `authored` to an operation declaration. They are mutually exclusive, in the type and at load. It exports `derivationOf(declaration, entities)`, which says what shape an operation could be derived as, and the `DerivedKind` type. `defineOperations` also refuses a `derive` that does not match its shape (naming the clause that fails), a blank `authored`, and an `authored` on an operation nothing could derive. `emitModel(entities, { operations })` renders a `handlers` map into `model.json`, so a handler changing hands, or an exception and its reason, shows in the reviewed diff.
- `@substrat-run/kernel`: `operationsFor` leaves derived operations out of the handler map it requires, and handing one a handler is a compile error. A handler that arrives for one through a cast is refused at load. A derived handler checks the declared key first, reads and writes only the entity's declared columns through `ctx.sql`, answers `not_found` for a missing row, and emits the declared event once per write. An update that sends no fields writes nothing and emits nothing.
- `@substrat-run/contract-tests` exports `derivedHandlersContractSuite`. Both adapters run it.
- The engines declare no derivable operation, so they are unchanged apart from passing their operations to `emitModel`. The `create-substrat` template's `AGENTS.md` documents the rule.

A later release that learns a new derivable shape (`create` is next) will refuse operations that pass today. That is deliberate: each one gets the same choice.
