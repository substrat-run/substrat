---
"@substrat-run/contracts": minor
---

`defineOperations` refuses an unpaged list read whatever wraps the array, and refuses an opaque output (#2436). The paged-list gate (#811) used to look only at a top-level `z.array(...)`, so an array under `.optional()`, `.nullable()`, `.nullish()`, `.default()`, `.prefault()`, `.nonoptional()`, `.catch()`, `.readonly()`, `.pipe()`, `.transform()` or `z.lazy()` was never refused, and nor was a `z.custom()` output, which can hold anything.

**What is refused now.** An operation with no `paged` whose output is an array under any of those wrappers, or is a `z.custom()` schema (or a `z.lazy()` that cannot be read at declaration). A module that declares such an output stops loading, with the operation's name in the error. The remedy is the same as for a bare array: declare the entry schema as `output` and add `paged`, or, for an output that is not a list, declare its real schema.

**What is not.** An object with an array inside it, and a wrapped object, are untouched.
