---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-auth': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/demo-ticket0': patch
'@substrat-run/demo-manyfold': patch
'@substrat-run/demo-meridian': patch
---

An owner hand-over. Platform staff can now move an instance's owner seat to another member with `POST /tenants/:tenantId/scopes/:scopeId/owner-transfer`. The vertical moves its owner of record, seats the new owner, then revokes the old one. Before this, the owner of record never moved, so if the successor was later revoked and the scope locked out, the lockout repair re-seated the original owner. It now re-seats whoever the record names. A vertical opts in with vertical-host's new `transferOwner` hook (vertical-auth's `IdentityDO.transferOwner` is the reference); without it the route answers `501`. Every attempt is on the admin log as `transferOwner` rows naming both principals.
