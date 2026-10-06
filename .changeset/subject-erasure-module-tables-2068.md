---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

A subject erasure now reaches a vertical's own tables (#2068). Before this, `shredSubject` redacted events and destroyed the subject's key, but left the rows in a module's own tables as they were.

- Declare whose rows an entity holds beside its `erasable` fields: `erasure: { subjects: ['author_id'] }`. The erasure blanks those fields (NULL where the field allows it, `''` otherwise) on every row where a subject column equals the erased id. `erasure: { subjects, mode: 'delete' }` removes the row instead. The model refuses a blank that a column would reject, or that would collide on a `key`.
- For a link the row does not hold itself, declare `erasure: { mode: 'custom' }` and register `onSubjectErased(ctx, { subjectId })` on the module. The hook is synchronous. Its `ctx.sql` can only reach the module's own tables and run `SELECT`, `UPDATE`, `DELETE` and `INSERT`. It must be safe to run twice.
- The rows, the events and the key are erased in one transaction. If a hook throws, reaches outside its tables or returns a promise, nothing is erased, no receipt is written, and the erasure can be run again.
- Search indexes over the erased columns drop the words from their stored data, not only from results.
- The erasure receipt adds `verticalRows`, `hookRows` and `unreachedEntities`. The last one names every entity with `erasable` fields that declares no `erasure`, and `pnpm lint:model` warns on the same entities.
- On Cloudflare, an erasure is refused, with the key untouched, while the scope runs a vertical built before this change. Redeploy it, then run the erasure again.
