---
'@substrat-run/boundary-lint': patch
---

A generated migration is recognized with Windows paths and line endings, and a sentence that mentions `CREATE TABLE` is not recorded as a table. Both made the layer rules pass by missing the file, or fire on the word `for`, depending on the machine.
