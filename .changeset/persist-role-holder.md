---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
---

Persist a role definition's holder in both directories and the scope permission projection. Newly defined roles record `person` when omitted from the declaration; legacy rows keep the prior runtime decision until redefined. The platform role door now distinguishes an explicitly person-held role from a system-held role when all its keys are reserved.

A role made only of reserved keys must declare `holder: 'system'`, or the platform door refuses it; roles defined before the migration are unaffected until redefined.
