---
"@substrat-run/contracts": minor
"@substrat-run/engine-assistant": patch
---

A manifest's permission declaration may say `holder: 'system'`: the key is reserved to a system principal, and `lint:permissions` refuses it in any role a person can hold and in any entity grant shape. Additive: a declaration without it means what it meant before, anyone may hold the key. `engine-assistant` declares it on `assistant:run`, which replaces the table of reserved keys the permission checkpoint used to keep.
