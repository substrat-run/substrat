---
'@substrat-run/contracts': minor
'@substrat-run/cli': minor
'@substrat-run/docs': patch
---

A per-tenant store declared in `tenantStores` may say `kind: 'blob'`. `blobStores` stays accepted as the older spelling of the same declaration, and a binding named in both is refused, because both would be bound as `<BINDING>__<tenant>` on the serving script. A push still sends blobs in the manifest's `blobStores` and relational stores in `tenantStores`, so a control plane from before this change parses the same document it parses today.
