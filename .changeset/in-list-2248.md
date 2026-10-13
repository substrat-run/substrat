---
'@substrat-run/contracts': minor
'@substrat-run/boundary-lint': minor
'@substrat-run/kernel': patch
'@substrat-run/contract-tests': patch
---

A list of any length is one SQL parameter (#2248).

A Durable Object refuses a statement that binds more than 100 parameters, so
`WHERE id IN (${ids.map(() => '?').join(', ')})` passes every test with a small fixture and
fails the first hosted call whose list outgrew it.

- `inList(values)` from `@substrat-run/contracts` returns `{ sql, params }`: write
  `id IN ${list.sql}` and bind `...list.params`. The list travels as one JSON array and is
  read back with `json_each`, which is SQLite's own and runs the same on both adapters. An
  empty list matches nothing. Strings and finite numbers only; `NaN` and `Infinity` throw
  rather than turning into `null`.
- `boundary-lint` rule **R12** refuses a hand-built `IN (${…})` placeholder list in module
  code and names `inList`. A list of fixed, short length opts out in a
  `boundary-lint-allow R12` … `boundary-lint-end R12` block.
- On the node adapter, the bound-parameter refusal now names the way round it after the
  Durable Object's own words. The message still starts with `too many SQL variables at offset N: SQLITE_ERROR`.
