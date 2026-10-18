---
"@substrat-run/contracts": minor
---

A role definition may declare `holder: 'system'` (absent still means a person). A system-held role is the one role that may carry a key reserved to a system principal, and `lint:permissions` renders it in its own section of `PERMISSIONS.md`. Additive: no existing role changes meaning.
