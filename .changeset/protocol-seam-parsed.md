---
'@substrat-run/engine-protocol': patch
---

engine-protocol validates its return values at the seam, not just its inputs (#771). Every published shape — template, instance, response, signature and signature-request rows, and the `protocol/get`, `protocol/sign`, `protocol/list-for-entity` and `protocol/request-signatures` composites — is parsed on the way out by the schema `schemas.ts` publishes, and no read is `SELECT *`: the column list is derived from the published schema, so a column dropped or renamed upstream fails at the read naming itself, a column added upstream never crosses, and a retyped column throws `internal` at the seam instead of surfacing as wrong data. Additive: the shapes are unchanged; a row that matches still crosses, unchanged.
