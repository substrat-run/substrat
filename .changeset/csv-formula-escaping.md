---
'@substrat-run/contracts': minor
'@substrat-run/boundary-lint': minor
'create-substrat': patch
---

A CSV export a spreadsheet opens as data, never as a formula.

- `csvTable(header, rows)` and `csvCell(value)` from `@substrat-run/contracts`. A cell starting with `=`, `+`, `-`, `@`, a tab, CR or LF gets a leading `'`, then RFC 4180 quoting; a decimal string such as `-12.50` and a number are written as they are, and `null` is an empty cell.
- `boundary-lint` rule **R13** refuses CSV cells joined by hand with `','` in module code, and names `csvTable`. A join that is not a CSV row opts out in a `boundary-lint-allow R13` … `boundary-lint-end R13` block.
- The scaffold's `AGENTS.md` gains rule 12: a CSV is written by `csvTable`.
