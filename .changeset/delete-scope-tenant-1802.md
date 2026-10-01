---
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
---

Pass the tenant ID through the control plane's delete-scope request to `onDeleteScope`, so a vertical can remove a deleted scope from a tenant-specific registry. The vertical route still accepts older requests without a tenant ID; hooks receive `undefined` for those requests. `VerticalClient.deleteScope` callers now provide both IDs.
