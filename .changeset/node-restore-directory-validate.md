---
'@substrat-run/adapter-sqlite': patch
'@substrat-run/contract-tests': patch
---

`restoreDirectory` on the SQLite adapter now validates the dump before replaying it, as the Durable Object adapter does. A dump whose table or column names are not plain identifiers, or whose DDL carries more than one statement, is refused and the directory is left as it was.
