---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
---

A scope store's upload plan names one script per kind and vertical, and that name does not include the kind's release, so a new release does not move the objects. A call to the store carries an HMAC of the object name. The key stays with the control plane and the store script.
