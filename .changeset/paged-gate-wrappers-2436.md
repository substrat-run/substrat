---
"@substrat-run/contracts": minor
---

`defineOperations` refuses an unpaged list read whatever wraps the array, and refuses an output it cannot read (#2436). The paged-list gate (#811) used to look only at a top-level `z.array(...)`, so an array under `.optional()`, `.nullable()`, `.default()`, `.readonly()`, `z.lazy()` or a union was never refused, and nor was a `z.custom()` output, which can hold anything.

**What is refused now.** An operation with no `paged` whose output is:
- an array under any of `.optional()`, `.nullable()`, `.nullish()`, `.default()`, `.prefault()`, `.nonoptional()`, `.catch()`, `.readonly()`, `z.promise()`, `z.lazy()`, a pipe's out side, an option of a union (`array.or(z.null())`), a side of an intersection or an element of a fixed tuple. The refusal names the wrapper.
- a `z.record()`, `z.map()`, `z.set()`, a tuple with a rest element or an object with a `catchall` (a record by another spelling; `looseObject` and `strictObject` are not one): a container whose size the caller does not bound.
- an output the gate cannot read: `z.custom()` (and `z.instanceof()`), `z.any()`, `z.unknown()`, or a transform (`.transform()`). A pipe is judged at its out side, which is what the handler returns: `array.pipe(object)` is accepted, `array.transform(fn)` is not.
- a `z.lazy()` whose getter throws, or a schema nested too deep to judge.

A module that declares such an output stops loading, with the operation's name in the error. The remedy is the same as for a bare array: declare the entry schema as `output` and add `paged`.

**What is not.** An object with an array inside it, and a wrapped object, are untouched.
