---
"@substrat-run/model-emit": patch
---

`planMigration` reads each column's `CHECK` and refuses a `z.enum` whose values changed, instead of reporting `up-to-date`. SQLite cannot alter a `CHECK` in place, so a widened enum used to plan as up to date while every scope built from the journal refused the new value at runtime; a narrowed one went on accepting a value the model no longer allows. Values compare as a set, so reordering is not a change, and a hand-written `CHECK` the model cannot declare is left alone. The refusal names what a table rebuild must re-create: indexes (including the kernel's derived list indexes), triggers (including search-index triggers), and foreign keys referencing the table. New exports: `journalChecks`, `columnChecks`, `normaliseSql`.
