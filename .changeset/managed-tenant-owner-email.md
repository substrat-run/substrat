---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
'@substrat-run/vertical-auth': minor
---

A `provision-tenant` request can name the requester's verified address as `instance.ownerEmail`. The new scope's owner seat then opens no first-sign-in window, and only a sign-in whose issuer verified that address claims it. A claim link still works.
