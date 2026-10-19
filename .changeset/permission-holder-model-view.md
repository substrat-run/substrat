---
"@substrat-run/model-view": minor
---

`parsePermissions` reads the registry's "Reserved to a system principal" column: `reserved` names the keys a manifest declares `holder: 'system'`, and `registryUnreadable` is set when the Registry table is not one `lint:permissions` writes (a header or a reservation cell it cannot read). `readRegistryTable` is that judgement, shared with `substrat plan`'s classifier; `syncConcept` refuses an unreadable registry rather than rendering it without descriptions.
