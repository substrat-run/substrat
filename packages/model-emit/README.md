# @substrat-run/model-emit

Build-time tooling over a Substrat [model](https://substrat.net/concepts/model).

Separate from `@substrat-run/contracts` on purpose. Contracts is the **vocabulary** a
vertical imports at runtime; this is what you *run to build*, and it has no business in the
runtime dependency graph of every vertical that declares a model.

Licensed Apache-2.0 like the rest of the build surface: LICENSING.md's line is whether a
package is the substrate you run to serve (AGPL) or something you build with (Apache).
A generator is the second.

| export | what it does |
|---|---|
| `emitTables(entities)` | `CREATE TABLE` derived from the entity registry |
| `journalColumns(sql)` | columns per table from a migration journal — the verification half |

The two belong together: the emitter's correctness claim is *"what this emits is what the
database ends up with"*, and the reader is how that gets checked. They are held to each other
rather than each to a hand-written string.

It reads the **TypeScript model**, never `model.json`. `z.toJSONSchema` keeps declarative
constraints and silently drops `.refine()` and `.brand()`, so an emitter reading the JSON
would produce a schema weaker than the model declares.
