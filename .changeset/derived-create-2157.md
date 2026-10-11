---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/contract-tests': minor
'create-substrat': patch
'@substrat-run/docs': patch
---

**Breaking:** `create` is now a derivable shape (#2157). After upgrading, `defineOperations` refuses at module load a create that matches it and declares neither `derive` nor `authored`, and the error names the operation and both remedies:

- Declare `derive: 'create'` and delete the handler. `operationsFor` no longer asks for it and supplies the platform's.
- Or keep the handler and declare `authored: '<what the derived create would get wrong here>'`.

A create matches when it is served as `POST`, emits about the row by its id, answers with the entity's own `fields`, and every column of the row is filled by exactly one thing the model names:

- the primary key, a minted ULID (so it must be a single string column);
- the link column `<parent>_id`, from the id of the parent the check is narrowed to;
- an input field, filling the column of its snake_case name, of the same type (string or number);
- a declared stamp (below);
- the column's default (`NULL` unless the table sets one), for a nullable column nothing else names: it is left out of the insert. An optional input the caller leaves out is written as `NULL`.

The derived create checks the declared key first. With a parent, it answers `not_found` for a parent that does not exist and links the new row to the parent, so the parent's grants reach it. On an entity with a natural `key`, a row already holding that key is the answer, with no write and no event. Under a parent, that key must include the link column, or the create is not derivable. A replay answers on the write key alone, as a hand-written idempotent create does. An entity that declares `trash` or `archive` cannot pair a natural key with a derived create, because the replay would answer a row the kernel hides; that create is written by hand. Otherwise it inserts the row and emits the declared event once.

**Behaviour change, derived `list`:** a derived page whose check is narrowed to a parent now answers `not_found` for a parent that does not exist, where it answered an empty page. The check still comes first, so a caller without the key is still `permission_denied`.

What changes:

- `@substrat-run/contracts`:
  - `EntityDef.stamps`, `{ column: 'createdAt' | 'createdBy' }`, names the columns a derived create fills from the call: `ctx.now()` or the calling principal. A derived update refuses a body field that writes a stamped column. Only the created pair exists, because a row is inserted once and the declaration stays true of it. An updated pair waits for the host to hold it on every write, authored ones included.
  - `defineEntities` refuses a stamp on a column that is not a field, on the primary key, or on a column that is not a string. Stamps add no migration.
  - `emitModel` renders `stamps` into `model.json`. `DERIVED_KINDS` gains `'create'`, and the plan types gain `DerivedParent` and `DerivedStamp`.
  - `emittedModel`, the schema a reader such as the control plane parses a pushed `model.json` with, is forward-compatible. A `derive` kind, a stamp kind or an extra key on a handler entry that a newer emitter wrote is carried rather than refused. Before, a closed list refused every model whose emitter was newer than the reader, so a vertical's push was a 400 until the control plane was redeployed. What the reader holds is typed `IngressModel`. `emitModel` and the `EmittedModel` type still allow only the kinds this release knows, and `defineOperations` still refuses an unknown kind at load.
- `@substrat-run/kernel`: the derived create, with its stamps, and the parent-existence check on a derived list.
- `@substrat-run/contract-tests`: `derivedHandlersContractSuite` covers both on both adapters.

Nothing derives a hook around a handler: an operation that needs one more step than its shape stays authored.
