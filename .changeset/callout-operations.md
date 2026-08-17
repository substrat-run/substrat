---
"@substrat-run/contracts": minor
---

`input` becomes omittable, and the model gains `EntityRow` / `OperationImpl` — all three found by the first adopter.

**`input` is optional now.** Three of Callout's six declarable operations take no
body, and a required `z.object({})` cannot say so: a handler accepting only
`undefined` is not assignable to one accepting `{}`. Omitting `input` means no
body, and the handler takes `undefined` — mirroring `ApiOperationDoc.input`
("Omit = no body") rather than inventing a second vocabulary. `inputOptional`
remains for the different case of a body that may also be absent.

**`OperationImpl<Ops, Ctx>`** is the handler map a declared operation set
requires — CRM-EFF's `satisfies Impl` seam, which is what makes a declaration
binding rather than decorative. A handler whose input or return disagrees with
the declaration is an error at the exact method, as is an operation declared and
not implemented, or implemented and not declared. `Ctx` is a parameter because
contracts sits below the kernel and must not import it.

**`EntityRow<T, K>`** is a declared entity's row type — what `ctx.sql.query`
returns for it. `ctx.sql.query` leaves `T` to the vertical, so every vertical
hand-writes row interfaces and the schema ends up described three times: the DDL,
the registry, and `interface CustomerRow`. This collapses the third into the
second.
