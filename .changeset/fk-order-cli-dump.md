---
'@substrat-run/cli': patch
---

`scope pull`/`scope restore` now emit FK-ordered dumps. A dump's `tables` array
carried no ordering guarantee, so a child table could precede its parent (e.g.
`crm_bank_accounts` before `crm_vendors`) and a loader that inserts in array order
tripped `FOREIGN KEY constraint failed` on the child's first row. The CLI now orders
every table after the tables it references before writing a `.sqlite` (`pull`) or
POSTing a restore, so parents insert first for any loader — including a control plane
that predates the adapters' `defer_foreign_keys` fix. Cycles and self-references are
tolerated (broken deterministically; the loader's deferral covers those rows).
