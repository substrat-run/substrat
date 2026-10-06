---
id: K-46
date: 2026-10-06
layer: kernel
title: "Subject erasure reaches a module's own tables by declaration or by a narrow synchronous hook, in the spine's transaction"
status: proposed
aliases: []
amends: ["K-37"]
tracking: ["#2068", "#37"]
---

# K-46 — Subject erasure reaches a module's own tables by declaration or by a narrow synchronous hook, in the spine's transaction

**K-37 left one half of open question 17 named and unbuilt: a vertical's own tables.** `shredSubject` redacted the spine and destroyed the key that seals the platform's copies, and a field a model marked `erasable` was kept off every event, but the row the field lives on is the module's and nothing reached it. That was limit 2 in kernel-design §13.1. It is now reached two ways, both run by the kernel inside the erasure.

**Declared, by default.** An entity names the columns whose value is a data subject id beside its `erasable` list: `erasure: { subjects: ['author_contact_id'] }`. A row is the subject's when any of those columns equals the id erased. The default mode, `blank`, sets each erasable field to NULL where the field admits it and to `''` where only that fits, and keeps the row and its envelope, which is K-37's Tier-1 line held on a module table. `mode: 'delete'` removes the row, for an entity that is the person's data whole. `manifestEntities()` derives the manifest's `erasure` block from the model, as it derives `searchables` and `entityStates`, so a vertical gets the behaviour by declaring it. The derivation refuses a blank that would fail mid-erasure or collide: a field that admits neither NULL nor `''`, a primary-key column, and a `''` into a `key` column.

**A hook, for a link the row does not hold.** `onSubjectErased(ctx, { subjectId })` on the `ModuleRegistration`, claimed per entity with `erasure: { mode: 'custom' }`. It is narrow on purpose. Its `sql` reaches only the module's own tables, which are the `tables` of its `erasure` block: a statement naming any other table in the scope (another module's, the spine, SQLite's own) is refused before it runs, reads included, and only `SELECT`, `WITH`, `UPDATE`, `DELETE`, `INSERT` and `REPLACE` run. It has `now()`, the erasure's instant, and nothing else: no emit, because an event about the erasure would be a new immutable copy of what is being erased, and no check, grant, link or platform request. It is synchronous, and a returned promise is refused. A hook with no `erasure` block, and a `custom` entity with no hook, are refused at registration.

**One transaction, before the key.** The module half runs in the same transaction as the spine redaction on both adapters, declared entities first and hooks after. A hook that throws, reaches past its tables or returns a promise rolls the whole scope side back, spine included, and the erasure throws before the key is touched or a receipt is written. A re-run converges: a declared blank skips rows already blank, and a hook is idempotent by contract. On the Durable-Object host the refusal crosses the RPC as data so its code survives, and a coordinator refuses a ScopeDO built before this (its reply has no module half) before destroying the key, as it refuses the pre-#1600 and pre-#1632 replies.

**The receipt says what was reached and what was not.** Three defaulted fields, counts only: `verticalRows` (per declared entity, zeros included), `hookRows` (per module), and `unreachedEntities`, every entity holding erasable fields that neither declares subject columns nor is claimed by a hook. `lint:model` prints the same gap as a warning (a GitHub annotation in CI), so it is read before a deploy, not first on a receipt.

**Search indexes are erased in their stored segments, not only in their results.** A searchable column is kept in step by its FTS5 triggers, but a plain FTS5 delete leaves the term in the older segment until a merge, readable by anyone with the database file. The erasure runs with FTS5 `secure-delete` switched on for the indexes over the erasing modules' tables, for that transaction only, which removes each entry where it sits. A full `optimize` would also remove it, at 0.5 s on a 100 000-row index against 0.2 ms for the secure delete (measured), and inside a transaction that holds the scope. An index an erasure has deleted from under `secure-delete` is recorded at FTS5 format version 5, which only SQLite 3.42 and later read. So the kernel refuses an erasure over a search index on an older runtime before writing anything, and the contract suite asserts each adapter's runtime is past the floor. A dump never carries a search index (it is rebuilt on load), so the reader that matters is the runtime holding the scope's own file.

## What it does not do, stated

- **A module whose manifest is hand-written declares no `erasure` block**, and so its erasable fields are not even named unreached on a receipt. Today that is the engines (`engine-invites`'s invitation); `lint:model` still warns on them from their emitted model.
- **SQLite's free pages are not overwritten.** A blanked value's old bytes can stay in a page SQLite has freed and not reused, and in the WAL, until those pages are reused or the file is vacuumed. A Durable Object does not let module or kernel code set `secure_delete` or run `VACUUM`. This is the same residue the spine's own redaction has always had; it is now written down.
- **Attachment text is not reached.** An attachment carries no subject, so neither its bytes nor its extracted text index (#1575) is in an erasure.
- **One id space, one subject per call.** A customer and a staff member are both erased by their id (contact or principal, both ULIDs). Erasing a person known by two ids is two calls.

## Why

**Declared first, hook second.** A hand-written UPDATE per vertical is how a column gets forgotten, and the `erasable` list already names the columns, so the subject link is the only fact missing. The hook exists for the link a row does not carry, and is held narrow because the erasure runs with the kernel's own handle, outside every operation's permission check.

**Synchronous, in one transaction.** An async hook would hold the erasure open across awaits, which interleaves with the scope's other writers and cannot be one SQLite transaction on the Durable-Object host. Synchronous keeps the property K-37's order rests on: everything reachable goes together, before the irreversible half.
