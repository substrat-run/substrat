---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-auth': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': minor
'@substrat-run/demo-ticket0': patch
'@substrat-run/demo-manyfold': patch
'@substrat-run/demo-meridian': patch
'@substrat-run/dashboard-web': patch
---

An owner hand-over. Platform staff can now move an instance's owner seat to another member with `POST /tenants/:tenantId/scopes/:scopeId/owner-transfer`. The vertical moves its owner of record, seats the new owner, then revokes the old one. Before this, the owner of record never moved, so if the successor was later revoked and the scope locked out, the lockout repair re-seated the original owner. It now re-seats whoever the record names. The new owner must already be a member who holds a role in the instance, and a second hand-over is refused while one is unfinished; resending the unfinished one completes it, and a repeat after that changes nothing. A re-provision now seats the owner of record rather than the principal the platform minted at install. A vertical opts in with vertical-host's new `transferOwner` and `completeOwnerTransfer` hooks (vertical-auth's `IdentityDO` methods are the reference); without them the route answers `501`. Every attempt is on the admin log as `transferOwner` rows naming both principals.
