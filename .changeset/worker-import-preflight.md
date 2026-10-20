---
'@substrat-run/cli': minor
---

Refuse Worker entries with transitive static or dynamic Node builtin imports before push, preview, or `push --check` when their compatibility flags do not allow them. Show the import path and a remedy.
