---
'@substrat-run/boundary-lint': minor
---

R8: an engine may not read with a star. `SELECT *`, `SELECT DISTINCT *` and the qualified
`SELECT t.*` in an engine's module code are now violations — a star publishes whatever
columns the physical table currently holds, so a column that moves between two engine
versions reaches a vertical as wrong data on a screen rather than a throw. A read names
its columns (`columnsOf(schema)`) and returns through `returns(schema, …)`. Scoped to
engine packages, with the reviewable `boundary-lint-allow R8` … `boundary-lint-end R8`
hatch R5 and R6 carry. `SELECT COUNT(*)` is untouched.

A config-declared package with `"engine": true` now defaults to no harness exemptions, the
same as `engines/*` in the monorepo — an engine's `index.ts` is its whole surface, not a
composition root, so it was the one file every rule skipped.
