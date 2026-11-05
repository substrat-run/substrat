---
'@substrat-run/contracts': minor
---

`PLATFORM_STORE_CODE` adds `substrat.scope_mismatch`, `substrat.undeclared_binding`, `substrat.reserved_operation` and `substrat.too_large`: a scope-store call the platform refuses now carries the refusing rule's code as `storeCode`. Code that compared `storeCode === 'substrat.refused'` for another scope, an undeclared binding, a reserved operation or a call body over the limit now sees that rule's code instead; `substrat.refused` remains for a platform refusal with no rule of its own. Read an unknown `substrat.` code as `substrat.refused` on a 4xx and `substrat.unavailable` on a 5xx.
