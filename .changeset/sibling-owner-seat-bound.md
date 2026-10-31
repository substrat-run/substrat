---
'@substrat-run/vertical-auth': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
---

A scope created by `provision-sibling` now gets its owner already signed in. The provision request carries `parentScopeId`, and `IdentityDO.setPendingOwner(scopeId, owner, parentScopeId)` binds the new scope's owner seat to the login the parent scope binds to that owner. Before this change, the seat opened the 15-minute first-sign-in window, so whichever login reached the new scope first became its owner. Pass `b.parentScopeId` from your `onProvision` hook to get this. If the parent binds no login to the owner, the seat waits for a claim link and no first sign-in can take it.
