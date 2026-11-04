---
'@substrat-run/contracts': minor
'@substrat-run/kernel': patch
---

`StoreError` takes an optional platform-written detail that rides in its message whatever the status, so a driver that breaks the page contract (a chain that repeats a cursor, a commit that miscounts its tables) says why. A read now refuses a chain that returns to any cursor it already asked with, not only the last one.
