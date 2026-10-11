---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
'@substrat-run/docs': patch
---

A vertical can declare `scopeStores`: one platform-run object per scope, a binding plus a kind. The only kind is `ontomate`, and it has no default. The platform would bind it as `SUBSTRAT_STORE_<BINDING>`. A binding already used by another store is refused, and so is `ATTACHMENTS`. A kind with no registration is refused by the push and again by the control plane. No kind is registered yet, so declaring a scope store does not deploy one.
