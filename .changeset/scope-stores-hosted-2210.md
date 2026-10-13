---
'@substrat-run/contracts': patch
'@substrat-run/control-plane-api': minor
---

Scope-store script names. `scopeStoreScriptName(vertical, kind)` gives each (kind, vertical) pair its own script name, and two different pairs never share one. The name carries no release and no version, so a new release of a kind is planned into the same script. The `substrat-store` script names are reserved: a vertical slug or a tenant slug that would deploy under one is refused at registration and at push. A store kind id is `[a-z0-9]+` (`storeKindId`), and a kind registration no longer names its own script.

The control plane gains `scopeStoreUploadPlan`, which lists the store scripts a vertical's stores need, and `verticalUploadBindings`, which both of a vertical's uploads now use. A declared scope store adds no binding to a vertical's upload, and `scopeStoreScriptBindings` is removed. Nothing uploads a store script or signs a store call yet, and the plan carries no Durable Object migration. Objects stay put across a kind's releases only because the script name and the object name are both stable.

The name MAC helpers in contracts are internal and not a supported API.
