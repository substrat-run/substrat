---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
'@substrat-run/vertical-auth': minor
'@substrat-run/create-substrat': patch
---

A `provision-tenant` request can name the requester's verified address as `instance.ownerEmail`. The new scope's owner seat then opens no first-sign-in window, and only a sign-in whose issuer verified that address claims it. A claim link still works.

A vertical's `onProvision` hook must pass `ownerEmail` on to `setPendingOwner` and return what it answers. The provision route refuses (501) a request naming an address that the hook did not report reserved, and the platform fails such a `provision-tenant` request without activating the scope, so a vertical that cannot reserve the seat never leaves the window open on a tenant reported as created. Deleting a scope deletes the address its seat was reserved for, and a claim clears it.
